import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiRelationship } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter, settle } from "../test/meter";
import {
  drainHeld,
  holdQueue,
  QUERIES_PER_INVOCATION,
  QUEUE_BATCH,
  QUEUE_INVOCATION_BUDGET,
} from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon sends the `status` notification ("notify me when this account
// posts") for a remote note as for a local one: `FeedInsertWorker#notify?`,
// to each notifying follower the home fan-out of its `Create` reaches. Not
// for a reply to someone else, a boost, or an edit, and for a limited or
// direct note only to the followers it names.

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

afterEach(() => {
  vi.restoreAllMocks();
});

const call = async (email: string, path: string, body?: object): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

/** Follow `remote` as `email` with `options`, and have it accept. */
const followRemote = async (email: string, remote: Remote, options: object): Promise<void> => {
  await call(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`, options);
  const viewer = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ follow_activity_id: z.string() }),
    (
      await env.DB.prepare(
        "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
      )
        .bind(viewer.id, remote.actorUri)
        .all()
    ).results,
  );
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const storedId = async (objectUri: string): Promise<string> => {
  const [row] = parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  );
  if (!row) {
    throw new Error(`remote note ${objectUri} was not stored`);
  }
  return row.id;
};

/** The `status` notifications stored for `email`'s account about `statusId`. */
const statusNotifications = async (email: string, statusId: string): Promise<number> => {
  const account = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ n: z.number() }),
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND status_id = ? AND kind = 'status'",
      )
        .bind(account.id, statusId)
        .all()
    ).results,
  );
  return row?.n ?? 0;
};

const actorOf = async (email: string): Promise<string> =>
  `https://example.com/users/${(await signedInAccount(email)).username}`;

/** Have `author` deliver a `Create` of the note `uri` with `fields`; its stored id. */
const create = async (author: Remote, uri: string, fields: object): Promise<string> => {
  expect(
    await author.send({
      id: `${uri}/create`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: author.actorUri,
        content: "<p>a note</p>",
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
        ...fields,
      },
    }),
  ).toBe(202);
  await settle();
  return storedId(uri);
};

describe("the status notification of a followed remote actor's note", () => {
  it("goes to each follower that asked for it, not to one that did not", async () => {
    const author = await remoteActor("rsnpublic", "rsn-public.example");
    await followRemote("rsn-public-notify@example.com", author, { notify: true });
    await followRemote("rsn-public-quiet@example.com", author, {});
    const relationship = z
      .array(ApiRelationship)
      .parse(
        await call(
          "rsn-public-notify@example.com",
          `/api/v1/accounts/relationships?id[]=${RemoteAccountId.encode(author.actorUri)}`,
        ),
      )[0];
    expect(expectContract(ApiRelationship, relationship).notifying).toBe(true);

    const id = await create(author, "https://rsn-public.example/notes/1", {});

    expect(await statusNotifications("rsn-public-notify@example.com", id)).toBe(1);
    expect(await statusNotifications("rsn-public-quiet@example.com", id)).toBe(0);
  });

  it("goes to each notifying follower for a followers-only note", async () => {
    const author = await remoteActor("rsnprivate", "rsn-private.example");
    await followRemote("rsn-private-notify@example.com", author, { notify: true });

    const id = await create(author, "https://rsn-private.example/notes/1", {
      to: [`${author.actorUri}/followers`],
      cc: [],
    });

    expect(await statusNotifications("rsn-private-notify@example.com", id)).toBe(1);
  });

  it("goes only to the notifying followers a direct or limited note names", async () => {
    const author = await remoteActor("rsndirect", "rsn-direct.example");
    await followRemote("rsn-direct-named@example.com", author, { notify: true });
    await followRemote("rsn-direct-silent@example.com", author, { notify: true });
    await followRemote("rsn-direct-other@example.com", author, { notify: true });
    const named = await actorOf("rsn-direct-named@example.com");
    const silent = await actorOf("rsn-direct-silent@example.com");

    const direct = await create(author, "https://rsn-direct.example/notes/direct", {
      to: [named],
      cc: [],
      tag: [{ type: "Mention", href: named }],
    });
    // In `to` without a `Mention` tag: a silent mention, which makes it limited.
    const limited = await create(author, "https://rsn-direct.example/notes/limited", {
      to: [named, silent],
      cc: [],
      tag: [{ type: "Mention", href: named }],
    });

    expect(await statusNotifications("rsn-direct-named@example.com", direct)).toBe(1);
    expect(await statusNotifications("rsn-direct-silent@example.com", direct)).toBe(0);
    expect(await statusNotifications("rsn-direct-other@example.com", direct)).toBe(0);
    expect(await statusNotifications("rsn-direct-named@example.com", limited)).toBe(1);
    expect(await statusNotifications("rsn-direct-silent@example.com", limited)).toBe(1);
    expect(await statusNotifications("rsn-direct-other@example.com", limited)).toBe(0);
  });

  it("goes to no follower for a reply to someone else or to an unknown note, and to each for a self-reply", async () => {
    const author = await remoteActor("rsnreply", "rsn-reply.example");
    const other = await remoteActor("rsnreplyother", "rsn-reply-other.example");
    await followRemote("rsn-reply-notify@example.com", author, { notify: true });
    const own = "https://rsn-reply.example/notes/own";
    const others = "https://rsn-reply-other.example/notes/theirs";
    await create(author, own, {});
    await create(other, others, {});

    const selfReply = await create(author, "https://rsn-reply.example/notes/self", {
      inReplyTo: own,
    });
    const reply = await create(author, "https://rsn-reply.example/notes/other", {
      inReplyTo: others,
    });
    const unknown = await create(author, "https://rsn-reply.example/notes/unknown", {
      inReplyTo: "https://rsn-reply-gone.example/notes/never-stored",
    });

    expect(await statusNotifications("rsn-reply-notify@example.com", selfReply)).toBe(1);
    expect(await statusNotifications("rsn-reply-notify@example.com", reply)).toBe(0);
    expect(await statusNotifications("rsn-reply-notify@example.com", unknown)).toBe(0);
  });

  it("goes to no follower whose follow keeps other languages", async () => {
    const author = await remoteActor("rsnlanguage", "rsn-language.example");
    await followRemote("rsn-language-ja@example.com", author, {
      notify: true,
      languages: ["ja"],
    });
    await followRemote("rsn-language-en@example.com", author, {
      notify: true,
      languages: ["en"],
    });

    const id = await create(author, "https://rsn-language.example/notes/1", {
      contentMap: { en: "<p>a note</p>" },
    });

    expect(await statusNotifications("rsn-language-ja@example.com", id)).toBe(0);
    expect(await statusNotifications("rsn-language-en@example.com", id)).toBe(1);
  });

  it("is sent once, and not again for an edit or a redelivery", async () => {
    const author = await remoteActor("rsnedit", "rsn-edit.example");
    await followRemote("rsn-edit-notify@example.com", author, { notify: true });
    const uri = "https://rsn-edit.example/notes/1";
    const published = new Date().toISOString();
    const id = await create(author, uri, { published });
    await create(author, uri, { published });

    expect(
      await author.send({
        id: `${uri}/update`,
        type: "Update",
        object: {
          id: uri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>an edited note</p>",
          published,
          updated: new Date(Date.now() + 1000).toISOString(),
          to: [PUBLIC],
          cc: [`${author.actorUri}/followers`],
        },
      }),
    ).toBe(202);
    await settle();

    expect(await statusNotifications("rsn-edit-notify@example.com", id)).toBe(1);
  });

  it("goes to no follower for a boost", async () => {
    const author = await remoteActor("rsnboost", "rsn-boost.example");
    const other = await remoteActor("rsnboostother", "rsn-boost-other.example");
    await followRemote("rsn-boost-notify@example.com", author, { notify: true });
    const boosted = await create(other, "https://rsn-boost-other.example/notes/1", {});

    expect(
      await author.send({
        id: "https://rsn-boost.example/announces/1",
        type: "Announce",
        object: "https://rsn-boost-other.example/notes/1",
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
      }),
    ).toBe(202);
    await settle();

    const account = await signedInAccount("rsn-boost-notify@example.com");
    const [row] = parseRows(
      z.object({ n: z.number() }),
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND kind = 'status'",
        )
          .bind(account.id)
          .all()
      ).results,
    );
    expect(row?.n).toBe(0);
    expect(await statusNotifications("rsn-boost-notify@example.com", boosted)).toBe(0);
  });
});

describe("a remote note of an actor many local accounts follow with notifications", () => {
  it(
    "notifies each one, past what the inbox request serves, within the D1 budgets",
    { timeout: 120_000 },
    async () => {
      const author = await remoteActor("rsncrowd", "rsn-crowd.example");
      const followers = Array.from({ length: 40 }, (_, n) => `rsn-crowd-${n}@example.com`);
      for (const email of followers) {
        await followRemote(email, author, { notify: true });
      }
      patchD1();
      const queued = holdQueue();
      const delivery = await author.delivery({
        id: "https://rsn-crowd.example/notes/1/create",
        type: "Create",
        object: {
          id: "https://rsn-crowd.example/notes/1",
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>hello followers</p>",
          published: new Date().toISOString(),
          to: [PUBLIC],
          cc: [`${author.actorUri}/followers`],
        },
      });
      await settle();
      resetMeter();
      const response = await SELF.fetch(delivery);
      expect(response.status).toBe(202);
      await settle();
      expect(meter.tally.statements).toBeLessThan(QUERIES_PER_INVOCATION / 2);
      const mostPerInvocation = await drainHeld(queued, ["FinishRemoteNoteRecipient"]);
      expect(
        mostPerInvocation,
        `one queue invocation of ${QUEUE_BATCH} jobs made ${mostPerInvocation} statements`,
      ).toBeLessThan(QUEUE_INVOCATION_BUDGET);

      const id = await storedId("https://rsn-crowd.example/notes/1");
      for (const email of followers) {
        expect(await statusNotifications(email, id), email).toBe(1);
      }
    },
  );
});
