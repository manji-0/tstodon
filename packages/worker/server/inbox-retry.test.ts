import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus, ApiStatusEdit } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { type Heard, openStream } from "../test/stream-fixture";
import { parseRows } from "./d1";
import { unsignedFetch } from "./federated-fetch";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";
import { applyRemoteUpdate } from "./remote-update";
import { parseInstanceIdentity } from "./runtime-config";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const note = (author: Remote, slug: string, extra: Record<string, unknown>) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  ...extra,
});

const hashtag = (name: string) => ({ type: "Hashtag", name: `#${name}` });

/**
 * Makes D1 refuse an insert into `table` whose `column` is `value`, until the
 * returned function is called. `name` is the trigger's, one per test, so a
 * trigger a test failed to drop does not reach the next one.
 */
const refuseInsert = async (
  name: string,
  table: "remote_status_tags" | "remote_status_remote_mentions",
  column: "tag" | "actor_uri",
  value: string,
): Promise<() => Promise<void>> => {
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
     WHEN NEW.${column} = '${value}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
};

const refuseTag = (tag: string) =>
  refuseInsert(`inbox_retry_${tag}`, "remote_status_tags", "tag", tag);

const storedId = async (objectUri: string): Promise<string | undefined> =>
  parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  )[0]?.id;

const status = async (id: string) =>
  expectContract(
    ApiStatus,
    await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).json(),
  );

const PUBLIC_STREAM = { kind: "Public", origin: "All", onlyMedia: false } as const;

/** The event a stream carried and the id of the status it is about. */
const heardStatus = (heard: Heard) => ({
  event: heard.event,
  id: expectContract(z.object({ id: z.string() }), JSON.parse(heard.payload)).id,
});

/** The kinds of late work the stored note is still owed (`remote_status_owed`). */
const owedKinds = async (statusId: string): Promise<string[]> =>
  parseRows(
    z.object({ kind: z.string() }),
    (
      await env.DB.prepare("SELECT kind FROM remote_status_owed WHERE status_id = ? ORDER BY kind")
        .bind(statusId)
        .all()
    ).results,
  ).map((row) => row.kind);

const remoteMentions = async (statusId: string): Promise<string[]> =>
  parseRows(
    z.object({ actor_uri: z.string() }),
    (
      await env.DB.prepare(
        "SELECT actor_uri FROM remote_status_remote_mentions WHERE status_id = ? ORDER BY actor_uri",
      )
        .bind(statusId)
        .all()
    ).results,
  ).map((row) => row.actor_uri);

/** A signed-in local account: its id, its request headers and its actor URL. */
const localAccount = async (email: string) => {
  const headers = await authHeaders(email);
  const account = expectContract(
    z.object({ id: z.string(), username: z.string() }),
    await (
      await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", { headers })
    ).json(),
  );
  return { id: account.id, headers, actorUrl: `https://example.com/users/${account.username}` };
};

/**
 * Makes D1 refuse the mention row of the local account `accountId` on a
 * remote note, until the returned function is called.
 */
const refuseMentionRow = async (name: string, accountId: string): Promise<() => Promise<void>> => {
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON remote_status_mentions
     WHEN NEW.account_id = '${accountId}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
};

/** How many notifications of `type` about status `id` the account holds. */
const notifiedOf = async (
  headers: Record<string, string>,
  type: string,
  id: string,
): Promise<number> =>
  expectContract(
    z.array(z.object({ status: z.object({ id: z.string() }) })),
    await (
      await SELF.fetch(`https://example.com/api/v1/notifications?types[]=${type}`, { headers })
    ).json(),
  ).filter((entry) => entry.status.id === id).length;

/** `env` whose first D1 batch waits for `between` to run first, as another request would. */
const interleaving = (between: () => Promise<unknown>): Env => {
  let ran = false;
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!ran) {
            ran = true;
            await between();
          }
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get: (target, key) => (key === "DB" ? db : Reflect.get(target, key)),
  });
};

/** The cached actor of `author` and this instance's identity, for a handler called directly. */
const signerOf = async (author: Remote) => {
  const identity = parseInstanceIdentity(env);
  const signer = (await findRemoteActorsByUris(env.DB, [author.actorUri]))
    .unwrapOr(undefined)
    ?.get(author.actorUri);
  if (identity.isErr() || !signer) {
    throw new Error("signer fixture rejected");
  }
  return { identity: identity.value, signer };
};

describe("an inbox activity that failed after its row was stored", () => {
  it("finishes a Create's mentions, notification and quote once when the same Create is redelivered", async () => {
    const mentioned = await localAccount("inbox-retry-create-late@example.com");
    const elsewhere = "https://elsewhere.example/users/retry-create-late";
    const author = await remoteActor("retry-create-late");
    const quoted = note(author, "retry-create-late-quoted", { content: "<p>quoted</p>" });
    expect(await author.send({ id: `${quoted.id}/create`, type: "Create", object: quoted })).toBe(
      202,
    );
    const quotedId = (await storedId(quoted.id)) ?? "";
    // A delivery that finished owes nothing.
    expect(await owedKinds(quotedId)).toEqual([]);
    const object = note(author, "retry-create-late", {
      content: "<p>hi @you @them</p>",
      tag: [
        { type: "Mention", href: mentioned.actorUrl },
        { type: "Mention", href: elsewhere },
      ],
      cc: [mentioned.actorUrl],
      quote: quoted.id,
    });
    const activity = { id: `${object.id}/create`, type: "Create", object };

    const allow = await refuseInsert(
      "inbox_retry_create_late",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    let id = "";
    try {
      expect(await author.send(activity)).toBe(500);
      id = (await storedId(object.id)) ?? "";
      expect(await owedKinds(id)).toEqual(["Created"]);
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);
    expect(await remoteMentions(id)).toEqual([elsewhere]);
    expect((await status(id)).quote).toMatchObject({
      state: "accepted",
      quoted_status: { id: quotedId },
    });
    expect(await owedKinds(id)).toEqual([]);

    // Nothing is owed any more: the same note delivered again notifies nobody.
    expect(await author.send({ ...activity, id: `${object.id}/create-again` })).toBe(202);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);
  });

  it("notifies a mentioned account when the Create that failed before its mention row was written is redelivered", async () => {
    const mentioned = await localAccount("inbox-retry-create-early@example.com");
    const author = await remoteActor("retry-create-early");
    const object = note(author, "retry-create-early", {
      content: "<p>hi @you</p>",
      tag: [{ type: "Mention", href: mentioned.actorUrl }],
      cc: [mentioned.actorUrl],
    });
    const activity = { id: `${object.id}/create`, type: "Create", object };

    const allow = await refuseMentionRow("inbox_retry_create_early", mentioned.id);
    let id = "";
    try {
      expect(await author.send(activity)).toBe(500);
      id = (await storedId(object.id)) ?? "";
      expect(await owedKinds(id)).toEqual(["Created"]);
      expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(0);
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);
    expect(await owedKinds(id)).toEqual([]);
  });

  /** A stored note of `author` that the local account `email` boosted. */
  const boostedNote = async (author: Remote, slug: string, email: string) => {
    const original = note(author, slug, { content: "<p>before</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const booster = await authHeaders(email);
    const boosted = await SELF.fetch(`https://example.com/api/v1/statuses/${id}/reblog`, {
      method: "POST",
      headers: booster,
    });
    expect(boosted.status).toBe(200);
    return { id, booster };
  };

  it("notifies a booster of an edit once when the Update that failed after its row was stored is redelivered", async () => {
    const elsewhere = "https://elsewhere.example/users/retry-update-late";
    const author = await remoteActor("retry-update-late");
    const { id, booster } = await boostedNote(
      author,
      "retry-update-late",
      "inbox-retry-update-late@example.com",
    );
    const edited = note(author, "retry-update-late", {
      content: "<p>after</p>",
      tag: [{ type: "Mention", href: elsewhere }],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseInsert(
      "inbox_retry_update_late",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect(await author.send(activity)).toBe(500);
      expect((await status(id)).content).toBe("<p>after</p>");
      expect(await owedKinds(id)).toEqual(["Edited"]);
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await notifiedOf(booster, "update", id)).toBe(1);
    expect(await remoteMentions(id)).toEqual([elsewhere]);
    expect(await owedKinds(id)).toEqual([]);

    // The edit is finished: the same content delivered again is not one.
    expect(await author.send({ ...activity, id: `${edited.id}/update-again` })).toBe(202);
    expect(await notifiedOf(booster, "update", id)).toBe(1);

    const second = note(author, "retry-update-late", {
      content: "<p>after again</p>",
      updated: "2026-10-22T00:00:00.000Z",
    });
    expect(await author.send({ id: `${second.id}/update-2`, type: "Update", object: second })).toBe(
      202,
    );
    expect(await notifiedOf(booster, "update", id)).toBe(2);
    expect(await owedKinds(id)).toEqual([]);
  });

  it("notifies a booster once when the Update that failed after every late step is redelivered", async () => {
    const author = await remoteActor("retry-update-clear");
    const { id, booster } = await boostedNote(
      author,
      "retry-update-clear",
      "inbox-retry-update-clear@example.com",
    );
    const edited = note(author, "retry-update-clear", {
      content: "<p>after</p>",
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    await env.DB.prepare(
      `CREATE TRIGGER inbox_retry_update_clear BEFORE DELETE ON remote_status_owed
       WHEN OLD.status_id = '${id}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
    ).run();
    try {
      expect(await author.send(activity)).toBe(500);
      expect(await notifiedOf(booster, "update", id)).toBe(1);
      expect(await owedKinds(id)).toEqual(["Edited"]);
    } finally {
      await env.DB.prepare("DROP TRIGGER inbox_retry_update_clear").run();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await notifiedOf(booster, "update", id)).toBe(1);
    expect(await owedKinds(id)).toEqual([]);
  });

  it("notifies the account an edit newly mentions when the Update that failed before its mention row was written is redelivered", async () => {
    const mentioned = await localAccount("inbox-retry-update-added@example.com");
    const author = await remoteActor("retry-update-added");
    const original = note(author, "retry-update-added", { content: "<p>before</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-update-added", {
      content: "<p>after @you</p>",
      tag: [{ type: "Mention", href: mentioned.actorUrl }],
      cc: [mentioned.actorUrl],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseMentionRow("inbox_retry_update_added", mentioned.id);
    try {
      expect(await author.send(activity)).toBe(500);
      expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(0);
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);
    expect(await owedKinds(id)).toEqual([]);
  });

  it("notifies nobody of a mention the note already had when an Update that failed after its row was stored is redelivered", async () => {
    const mentioned = await localAccount("inbox-retry-update-kept@example.com");
    const elsewhere = "https://elsewhere.example/users/retry-update-kept";
    const author = await remoteActor("retry-update-kept");
    const original = note(author, "retry-update-kept", {
      content: "<p>hi @you</p>",
      tag: [{ type: "Mention", href: mentioned.actorUrl }],
      cc: [mentioned.actorUrl],
    });
    const identity = parseInstanceIdentity(env);
    const signer = (await findRemoteActorsByUris(env.DB, [author.actorUri]))
      .unwrapOr(undefined)
      ?.get(author.actorUri);
    if (identity.isErr() || !signer) {
      throw new Error("fetch fixture rejected");
    }
    // Stored by a fetch (an Announce, a backfill): a mention row, and no notification.
    const fetched = await persistRemoteObject(env, identity.value, signer, original, {
      fetchSigner: unsignedFetch,
    });
    expect(fetched.isOk()).toBe(true);
    const id = (await storedId(original.id)) ?? "";
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(0);
    const edited = note(author, "retry-update-kept", {
      content: "<p>hi @you, edited</p>",
      tag: [
        { type: "Mention", href: mentioned.actorUrl },
        { type: "Mention", href: elsewhere },
      ],
      cc: [mentioned.actorUrl],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseInsert(
      "inbox_retry_update_kept",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect(await author.send(activity)).toBe(500);
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await owedKinds(id)).toEqual([]);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(0);
  });

  it("streams the edit when the Update that failed after its row was stored is applied again", async () => {
    const elsewhere = "https://elsewhere.example/users/retry-update-stream";
    const author = await remoteActor("retry-update-stream");
    const original = note(author, "retry-update-stream", { content: "<p>before</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-update-stream", {
      content: "<p>after</p>",
      tag: [{ type: "Mention", href: elsewhere }],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };
    const viewer = await openStream({
      email: "inbox-retry-update-stream@example.com",
      query: "?stream=public",
    });

    const allow = await refuseInsert(
      "inbox_retry_update_stream",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect(await author.send(activity)).toBe(500);
      expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(heardStatus(await viewer.next())).toEqual({ event: "status.update", id });
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    expect(await owedKinds(id)).toEqual([]);
    viewer.close();
  });
});

describe("two inbox activities that carry one note", () => {
  /** What `persistRemoteObject` takes to store `author`'s note as an inbox activity delivers it. */
  const deliverer = async (author: Remote) => {
    const identity = parseInstanceIdentity(env);
    const signer = (await findRemoteActorsByUris(env.DB, [author.actorUri]))
      .unwrapOr(undefined)
      ?.get(author.actorUri);
    if (identity.isErr() || !signer) {
      throw new Error("delivery fixture rejected");
    }
    return (object: Readonly<{ id: string } & Record<string, unknown>>) =>
      (delivery: "Create" | "QuoteRequest", running: Env = env) =>
        persistRemoteObject(running, identity.value, signer, object, {
          fetchSigner: unsignedFetch,
          delivery,
        });
  };

  it("stores the note once when a QuoteRequest stores it between a Create's read of its URI and its write", async () => {
    const mentioned = await localAccount("inbox-retry-raced@example.com");
    const author = await remoteActor("retry-raced");
    const object = note(author, "retry-raced", {
      content: "<p>hi @you #raced</p>",
      tag: [hashtag("raced"), { type: "Mention", href: mentioned.actorUrl }],
      cc: [mentioned.actorUrl],
    });
    const deliver = (await deliverer(author))(object);
    let first: Awaited<ReturnType<typeof deliver>> | undefined;

    const second = await deliver(
      "Create",
      interleaving(async () => {
        first = await deliver("QuoteRequest");
      }),
    );

    const id = (await storedId(object.id)) ?? "";
    expect(first?.isOk() && first.value?.id).toBe(id);
    expect(second.isOk() && second.value?.id).toBe(id);
    expect(
      parseRows(
        z.object({ id: z.string() }),
        (
          await env.DB.prepare("SELECT id FROM remote_statuses WHERE actor_uri = ?")
            .bind(author.actorUri)
            .all()
        ).results,
      ),
    ).toEqual([{ id }]);
    expect(await status(id)).toMatchObject({ tags: [{ name: "raced" }] });
    expect(await owedKinds(id)).toEqual([]);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);
  });

  // A smoke test, not the proof of the race: the test runtime does not run
  // the two requests' reads before either write, so this passes without the
  // fix too. The interleaved batch above is what fails without it.
  it("smoke: answers a QuoteRequest and a Create of one new note sent together with 202, and stores one row", async () => {
    const quoted = await localAccount("inbox-retry-at-once@example.com");
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...quoted.headers },
      body: JSON.stringify({ status: "quote me" }),
    });
    const quotedUri = `${quoted.actorUrl}/statuses/${expectContract(ApiStatus, await posted.json()).id}`;
    for (let round = 0; round < 6; round += 1) {
      const author = await remoteActor(`retry-at-once-${round}`);
      const object = note(author, `retry-at-once-${round}`, {
        content: "<p>quoting #atonce</p>",
        tag: [hashtag("atonce")],
        quote: quotedUri,
      });

      const answers = await Promise.all([
        author.send({
          id: `${author.actorUri}/quote_requests/${round}`,
          type: "QuoteRequest",
          object: quotedUri,
          instrument: object,
        }),
        author.send({ id: `${object.id}/create`, type: "Create", object }),
      ]);

      expect(answers).toEqual([202, 202]);
      const id = (await storedId(object.id)) ?? "";
      expect(await status(id)).toMatchObject({ tags: [{ name: "atonce" }] });
      expect(await owedKinds(id)).toEqual([]);
    }
  });

  it("notifies a mentioned account once when a Create arrives while the QuoteRequest that stored the note is in its late steps", async () => {
    const counts: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      const mentioned = await localAccount(`inbox-retry-concurrent-${round}@example.com`);
      const author = await remoteActor(`retry-concurrent-${round}`);
      const object = note(author, `retry-concurrent-${round}`, {
        content: "<p>hi @you</p>",
        tag: [{ type: "Mention", href: mentioned.actorUrl }],
        cc: [mentioned.actorUrl],
      });
      const deliver = (await deliverer(author))(object);

      const first = deliver("QuoteRequest");
      let id = await storedId(object.id);
      while (id === undefined || (await owedKinds(id)).length === 0) {
        id = await storedId(object.id);
      }
      const delivered = await Promise.all([first, deliver("Create")]);

      expect(delivered.every((result) => result.isOk())).toBe(true);
      counts.push(await notifiedOf(mentioned.headers, "mention", id));
    }
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("streams a new note when a QuoteRequest stores it, and not again when its Create arrives", async () => {
    const mentioned = await localAccount("inbox-retry-quote-first@example.com");
    const author = await remoteActor("retry-quote-first");
    // Published now: inside the real-time window, so it is streamed as new.
    const object = note(author, "retry-quote-first", {
      content: "<p>hi @you</p>",
      tag: [{ type: "Mention", href: mentioned.actorUrl }],
      cc: [mentioned.actorUrl],
      published: new Date().toISOString(),
    });
    const deliver = (await deliverer(author))(object);
    const viewer = await openStream({
      email: "inbox-retry-quote-first-viewer@example.com",
      query: "?stream=public",
    });

    expect((await deliver("QuoteRequest")).isOk()).toBe(true);
    const id = (await storedId(object.id)) ?? "";
    expect(heardStatus(await viewer.next())).toEqual({ event: "update", id });
    expect(await owedKinds(id)).toEqual([]);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);

    // Nothing is owed any more: the Create finds the note and streams nothing.
    expect((await deliver("Create")).isOk()).toBe(true);
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    expect(await notifiedOf(mentioned.headers, "mention", id)).toBe(1);
    viewer.close();
  });

  it("streams a new note once when a QuoteRequest finishes the Create that failed before the Create is redelivered", async () => {
    const elsewhere = "https://elsewhere.example/users/retry-create-stream";
    const author = await remoteActor("retry-create-stream");
    // Published now: inside the real-time window, so the Create streams it.
    const object = note(author, "retry-create-stream", {
      content: "<p>hi @them</p>",
      tag: [{ type: "Mention", href: elsewhere }],
      published: new Date().toISOString(),
    });
    const deliver = (await deliverer(author))(object);
    const viewer = await openStream({
      email: "inbox-retry-create-stream@example.com",
      query: "?stream=public",
    });

    const allow = await refuseInsert(
      "inbox_retry_create_stream",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect((await deliver("Create")).isErr()).toBe(true);
    } finally {
      await allow();
    }
    const id = (await storedId(object.id)) ?? "";
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);

    // The QuoteRequest finishes every step the Create left, the stream event included.
    expect((await deliver("QuoteRequest")).isOk()).toBe(true);
    expect(await remoteMentions(id)).toEqual([elsewhere]);
    expect(heardStatus(await viewer.next())).toEqual({ event: "update", id });
    expect(await owedKinds(id)).toEqual([]);

    expect((await deliver("Create")).isOk()).toBe(true);
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    viewer.close();
  });
});

describe("the late steps a failed Create left owed", () => {
  /** A Create of a note published now, which failed after its row was stored. */
  const failedCreate = async (slug: string) => {
    const elsewhere = `https://elsewhere.example/users/${slug}`;
    const author = await remoteActor(slug);
    // Published now: inside the real-time window, so the Create streams it.
    const object = note(author, slug, {
      content: "<p>hi @them</p>",
      tag: [{ type: "Mention", href: elsewhere }],
      published: new Date().toISOString(),
    });
    const activity = { id: `${object.id}/create`, type: "Create", object };
    const viewer = await openStream({ email: `${slug}@example.com`, query: "?stream=public" });
    const allow = await refuseInsert(
      slug.replaceAll("-", "_"),
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect(await author.send(activity)).toBe(500);
    } finally {
      await allow();
    }
    const id = (await storedId(object.id)) ?? "";
    expect(await owedKinds(id)).toEqual(["Created"]);
    return { author, object, activity, viewer, id };
  };

  it("start the fan-out once when two deliveries resume them at the same moment", async () => {
    const { author, object, viewer, id } = await failedCreate("inbox-retry-lease");
    const { identity, signer } = await signerOf(author);
    const resume = (running: Env) =>
      persistRemoteObject(running, identity, signer, object, {
        fetchSigner: unsignedFetch,
        delivery: "Create",
      });

    // The second delivery arrives while the first is in the late steps.
    let second: Awaited<ReturnType<typeof resume>> | undefined;
    const first = await resume(
      interleaving(async () => {
        second = await resume(env);
      }),
    );

    expect(first.isOk()).toBe(true);
    expect(heardStatus(await viewer.next())).toEqual({ event: "update", id });
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    expect(second?.isOk()).toBe(true);
    expect(await owedKinds(id)).toEqual([]);
    viewer.close();
  });

  it("are another delivery's while its lease stands, and are taken over once it is past", async () => {
    const { author, activity, viewer, id } = await failedCreate("inbox-retry-lease-past");
    const lease = (until: number) =>
      env.DB.prepare("UPDATE remote_status_owed SET claimed_until = ? WHERE status_id = ?")
        .bind(new Date(until).toISOString(), id)
        .run();

    // A delivery that was cut off in the late steps left its lease. Another
    // Create of the note has nothing of its own to do, and is answered 202.
    const again = (slug: string) => author.send({ ...activity, id: `${activity.id}/${slug}` });
    await lease(Date.now() + 30_000);
    expect(await again("held")).toBe(202);
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    expect(await owedKinds(id)).toEqual(["Created"]);

    await lease(Date.now() - 1000);
    expect(await again("past")).toBe(202);
    expect(heardStatus(await viewer.next())).toEqual({ event: "update", id });
    expect(await viewer.heardNothing(PUBLIC_STREAM)).toBe(true);
    expect(await owedKinds(id)).toEqual([]);
    viewer.close();
  });
});

describe("an inbox activity whose write failed", () => {
  it("answers a Create with a server error, and stores the note when the same Create is redelivered", async () => {
    const author = await remoteActor("retry-create");
    const object = note(author, "retry-create", {
      content: "<p>hello</p>",
      tag: [hashtag("retrycreate")],
    });
    const activity = { id: `${object.id}/create`, type: "Create", object };

    const allow = await refuseTag("retrycreate");
    try {
      expect(await author.send(activity)).toBe(500);
      expect(await storedId(object.id)).toBeUndefined();
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    const id = await storedId(object.id);
    expect(id).toBeDefined();
    expect((await status(id ?? "")).content).toBe("<p>hello</p>");
  });

  it("answers an Update with a server error, and applies the edit when the same Update is redelivered", async () => {
    const author = await remoteActor("retry-update");
    const original = note(author, "retry-update", { content: "<p>before</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-update", {
      content: "<p>after</p>",
      tag: [hashtag("retryupdate")],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseTag("retryupdate");
    try {
      expect(await author.send(activity)).toBe(500);
      expect((await status(id)).content).toBe("<p>before</p>");
    } finally {
      await allow();
    }

    expect(await author.send(activity)).toBe(202);
    expect(await status(id)).toMatchObject({
      content: "<p>after</p>",
      edited_at: "2026-10-21T00:00:00.000Z",
    });
  });

  it("keeps the replaced version once in the history when a failed Update is redelivered", async () => {
    const author = await remoteActor("retry-history");
    const original = note(author, "retry-history", { content: "<p>original</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-history", {
      content: "<p>edited</p>",
      tag: [hashtag("retryhistory")],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseTag("retryhistory");
    try {
      expect(await author.send(activity)).toBe(500);
    } finally {
      await allow();
    }
    expect(await author.send(activity)).toBe(202);

    const history = expectContract(
      z.array(ApiStatusEdit),
      await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`)).json(),
    );
    expect(history.map((version) => version.content)).toEqual(["<p>original</p>", "<p>edited</p>"]);
  });

  it("keeps each version once in the history when two Updates were computed from the same version", async () => {
    const author = await remoteActor("retry-stale-base");
    const original = note(author, "retry-stale-base", { content: "<p>original</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const first = note(author, "retry-stale-base", {
      content: "<p>first edit</p>",
      updated: "2026-10-21T00:00:00.000Z",
    });
    const second = note(author, "retry-stale-base", {
      content: "<p>second edit</p>",
      updated: "2026-10-22T00:00:00.000Z",
    });
    const secondUpdate = { id: `${second.id}/update-2`, type: "Update", object: second };
    const identity = parseInstanceIdentity(env);
    const signer = (await findRemoteActorsByUris(env.DB, [author.actorUri]))
      .unwrapOr(undefined)
      ?.get(author.actorUri);
    if (identity.isErr() || !signer) {
      throw new Error("update fixture rejected");
    }

    // The second Update has read the original when the first one is applied:
    // its first write waits for the first Update's delivery to finish.
    let interleaved = false;
    const db = new Proxy(env.DB, {
      get: (target, key) => {
        if (key !== "batch") {
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (statements: D1PreparedStatement[]) => {
          if (!interleaved) {
            interleaved = true;
            expect(
              await author.send({ id: `${first.id}/update-1`, type: "Update", object: first }),
            ).toBe(202);
          }
          return target.batch(statements);
        };
      },
    });
    const stale = await applyRemoteUpdate(
      new Proxy(env, { get: (target, key) => (key === "DB" ? db : Reflect.get(target, key)) }),
      identity.value,
      signer,
      second,
      { fetchSigner: unsignedFetch },
    );

    expect(interleaved).toBe(true);
    expect(stale.isErr()).toBe(true);
    expect((await status(id)).content).toBe("<p>first edit</p>");

    expect(await author.send(secondUpdate)).toBe(202);
    const history = expectContract(
      z.array(ApiStatusEdit),
      await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`)).json(),
    );
    expect(history.map((version) => version.content)).toEqual([
      "<p>original</p>",
      "<p>first edit</p>",
      "<p>second edit</p>",
    ]);
  });

  it("keeps an edit that was stored while an Update with the replaced content was being applied", async () => {
    const author = await remoteActor("retry-stale-refresh");
    const original = note(author, "retry-stale-refresh", { content: "<p>original</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edit = note(author, "retry-stale-refresh", {
      content: "<p>edit</p>",
      updated: "2026-10-22T00:00:00.000Z",
    });
    // The content the note had before the edit, as a refresh sent before it carries.
    const refresh = { ...original, updated: "2026-10-21T00:00:00.000Z" };
    const identity = parseInstanceIdentity(env);
    const signer = (await findRemoteActorsByUris(env.DB, [author.actorUri]))
      .unwrapOr(undefined)
      ?.get(author.actorUri);
    if (identity.isErr() || !signer) {
      throw new Error("update fixture rejected");
    }

    let interleaved = false;
    const db = new Proxy(env.DB, {
      get: (target, key) => {
        if (key !== "batch") {
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (statements: D1PreparedStatement[]) => {
          if (!interleaved) {
            interleaved = true;
            expect(
              await author.send({ id: `${edit.id}/update-edit`, type: "Update", object: edit }),
            ).toBe(202);
          }
          return target.batch(statements);
        };
      },
    });
    const stale = await applyRemoteUpdate(
      new Proxy(env, { get: (target, key) => (key === "DB" ? db : Reflect.get(target, key)) }),
      identity.value,
      signer,
      refresh,
      { fetchSigner: unsignedFetch },
    );

    expect(interleaved).toBe(true);
    expect(stale.isErr()).toBe(true);
    expect(
      await author.send({ id: `${refresh.id}/update-refresh`, type: "Update", object: refresh }),
    ).toBe(202);

    expect(await status(id)).toMatchObject({
      content: "<p>edit</p>",
      edited_at: "2026-10-22T00:00:00.000Z",
    });
    const history = expectContract(
      z.array(ApiStatusEdit),
      await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`)).json(),
    );
    expect(history.map((version) => version.content)).toEqual(["<p>original</p>", "<p>edit</p>"]);
  });

  it("notifies a newly mentioned account once when an Update that failed after its mention was recorded is redelivered", async () => {
    const headers = await authHeaders("inbox-retry-mention@example.com");
    const account = expectContract(
      z.object({ username: z.string() }),
      await (
        await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", { headers })
      ).json(),
    );
    const actorUrl = `https://example.com/users/${account.username}`;
    const elsewhere = "https://elsewhere.example/users/retry-mentioned";
    const author = await remoteActor("retry-mention");
    const original = note(author, "retry-mention", { content: "<p>hi</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    const edited = note(author, "retry-mention", {
      content: "<p>hi @you @them</p>",
      tag: [
        { type: "Mention", href: actorUrl },
        { type: "Mention", href: elsewhere },
      ],
      cc: [actorUrl],
      updated: "2026-10-21T00:00:00.000Z",
    });
    const activity = { id: `${edited.id}/update`, type: "Update", object: edited };

    const allow = await refuseInsert(
      "inbox_retry_remote_mention",
      "remote_status_remote_mentions",
      "actor_uri",
      elsewhere,
    );
    try {
      expect(await author.send(activity)).toBe(500);
    } finally {
      await allow();
    }
    expect(await author.send(activity)).toBe(202);

    const mentions = expectContract(
      z.array(z.object({ status: z.object({ id: z.string() }) })),
      await (
        await SELF.fetch("https://example.com/api/v1/notifications?types[]=mention", { headers })
      ).json(),
    );
    expect(mentions.filter((entry) => entry.status.id === id)).toHaveLength(1);
  });
});

describe("a delivery of a note whose stored row does not read as a status", () => {
  /** A stored note, then made unreadable as a row written by older code could be. */
  const unreadable = async (author: Remote, slug: string): Promise<string> => {
    const original = note(author, slug, { content: "<p>stored</p>" });
    expect(
      await author.send({ id: `${original.id}/create`, type: "Create", object: original }),
    ).toBe(202);
    const id = (await storedId(original.id)) ?? "";
    await env.DB.prepare("UPDATE remote_statuses SET visibility = 'unreadable' WHERE id = ?")
      .bind(id)
      .run();
    expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).status).not.toBe(200);
    return id;
  };

  const storedRow = async (id: string) =>
    parseRows(
      z.object({ visibility: z.string(), content_html: z.string() }),
      (
        await env.DB.prepare("SELECT visibility, content_html FROM remote_statuses WHERE id = ?")
          .bind(id)
          .all()
      ).results,
    )[0];

  it("answers the author's Create with 202 and replaces the row under its id", async () => {
    const author = await remoteActor("invalid-row-create");
    const id = await unreadable(author, "invalid-row-create");
    const object = note(author, "invalid-row-create", { content: "<p>sent again</p>" });

    expect(await author.send({ id: `${object.id}/create-again`, type: "Create", object })).toBe(
      202,
    );

    expect(await storedId(object.id)).toBe(id);
    expect(await status(id)).toMatchObject({
      content: "<p>sent again</p>",
      visibility: "public",
      edited_at: null,
    });
  });

  it("answers the author's Update with 202 and replaces the row, with no version kept", async () => {
    const author = await remoteActor("invalid-row-update");
    const id = await unreadable(author, "invalid-row-update");
    const object = note(author, "invalid-row-update", {
      content: "<p>edited</p>",
      updated: "2026-10-21T00:00:00.000Z",
    });

    expect(await author.send({ id: `${object.id}/update`, type: "Update", object })).toBe(202);

    expect(await status(id)).toMatchObject({ content: "<p>edited</p>", visibility: "public" });
    const history = expectContract(
      z.array(ApiStatusEdit),
      await (await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`)).json(),
    );
    expect(history.map((version) => version.content)).toEqual(["<p>edited</p>"]);
  });

  it("fails a replacement computed from a row another delivery replaced meanwhile, and keeps that one's", async () => {
    const author = await remoteActor("invalid-row-raced");
    const id = await unreadable(author, "invalid-row-raced");
    const edit = (content: string, updated: string) => {
      const object = note(author, "invalid-row-raced", { content, updated });
      return { id: `${object.id}/update/${updated}`, type: "Update", object };
    };
    const first = edit("<p>first edit</p>", "2026-10-21T00:00:00.000Z");
    const second = edit("<p>second edit</p>", "2026-10-22T00:00:00.000Z");
    const { identity, signer } = await signerOf(author);

    // The first Update has read the unreadable row when the second replaces
    // it: its write waits for the second one's delivery to finish.
    let between: number | undefined;
    const raced = await applyRemoteUpdate(
      interleaving(async () => {
        between = await author.send(second);
      }),
      identity,
      signer,
      first.object,
      { fetchSigner: unsignedFetch },
    );

    expect(between).toBe(202);
    expect(raced.isErr()).toBe(true);
    const kept = { content: "<p>second edit</p>", edited_at: "2026-10-22T00:00:00.000Z" };
    expect(await status(id)).toMatchObject(kept);

    // Its redelivery reads the row, which now reads: an older edit is dropped.
    expect(await author.send(first)).toBe(202);
    expect(await status(id)).toMatchObject(kept);
  });

  it("answers another actor's Update with 202 and leaves the row as it is", async () => {
    const author = await remoteActor("invalid-row-author");
    const other = await remoteActor("invalid-row-other");
    const id = await unreadable(author, "invalid-row-author");
    const object = note(author, "invalid-row-author", {
      content: "<p>not mine</p>",
      updated: "2026-10-21T00:00:00.000Z",
    });

    expect(await other.send({ id: `${object.id}/update`, type: "Update", object })).toBe(202);

    expect(await storedRow(id)).toEqual({
      visibility: "unreadable",
      content_html: "<p>stored</p>",
    });
  });
});

describe("a note document that parses but does not read as a status", () => {
  it("answers its Create and its Update with 202 and stores nothing of it, as a note that does not parse", async () => {
    const author = await remoteActor("unreadable-document");
    const stored = note(author, "unreadable-document", { content: "<p>stored</p>" });
    expect(await author.send({ id: `${stored.id}/create`, type: "Create", object: stored })).toBe(
      202,
    );
    const id = (await storedId(stored.id)) ?? "";
    // `url` is any string in the document, and a URL in a status.
    const broken = { url: "not a url", updated: "2026-10-21T00:00:00.000Z" };
    const fresh = note(author, "unreadable-document-new", { content: "<p>new</p>", ...broken });
    const edit = { ...stored, content: "<p>edited</p>", ...broken };

    expect(await author.send({ id: `${fresh.id}/create`, type: "Create", object: fresh })).toBe(
      202,
    );
    expect(await author.send({ id: `${edit.id}/update`, type: "Update", object: edit })).toBe(202);

    expect(await storedId(fresh.id)).toBeUndefined();
    expect(await status(id)).toMatchObject({ content: "<p>stored</p>", edited_at: null });
  });
});
