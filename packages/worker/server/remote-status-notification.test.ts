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
import { INLINE_NOTE_RECIPIENTS, NOTIFYING_FOLLOWER_PAGE_SIZE } from "./remote-status-persist";
import { OutboxJob } from "@tstodon/domain";
import { processOutboxJob } from "./outbox-job";

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

/** The notifications of `kind` stored for `email`'s account about `statusId`. */
const notificationsOf = async (email: string, statusId: string, kind: string): Promise<number> => {
  const account = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ n: z.number() }),
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND status_id = ? AND kind = ?",
      )
        .bind(account.id, statusId, kind)
        .all()
    ).results,
  );
  return row?.n ?? 0;
};

/** Serve each of `documents` by URL to the worker's fetches, and 404 anything else. */
const serve = (documents: ReadonlyMap<string, unknown>): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const document = documents.get(new Request(input, init).url);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  });
};

const HOUR_MS = 60 * 60 * 1000;

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

  it("goes to no follower who mutes the actor, even with its notifications left on", async () => {
    const author = await remoteActor("rsnmute", "rsn-mute.example");
    await followRemote("rsn-mute-follower@example.com", author, { notify: true });
    await call(
      "rsn-mute-follower@example.com",
      `/api/v1/accounts/${RemoteAccountId.encode(author.actorUri)}/mute`,
      { notifications: false },
    );

    const id = await create(author, "https://rsn-mute.example/notes/1", {});

    expect(await statusNotifications("rsn-mute-follower@example.com", id)).toBe(0);
  });

  // `filter_from_home` filters a status whose active mentions name an
  // account the follower blocks or mutes (`crutches[:active_mentions]`).
  it("goes to no follower who blocks or mutes an account or actor the note mentions", async () => {
    const author = await remoteActor("rsnmentions", "rsn-mentions.example");
    const muted = await remoteActor("rsnmentionsmuted", "rsn-mentions-muted.example");
    const blocked = await signedInAccount("rsn-mentions-blocked@example.com");
    await followRemote("rsn-mentions-blocker@example.com", author, { notify: true });
    await followRemote("rsn-mentions-muter@example.com", author, { notify: true });
    await call("rsn-mentions-blocker@example.com", `/api/v1/accounts/${blocked.id}/block`, {});
    await call(
      "rsn-mentions-muter@example.com",
      `/api/v1/accounts/${RemoteAccountId.encode(muted.actorUri)}/mute`,
      { notifications: false },
    );
    const blockedActor = await actorOf("rsn-mentions-blocked@example.com");

    const naming = await create(author, "https://rsn-mentions.example/notes/naming", {
      cc: [`${author.actorUri}/followers`, blockedActor, muted.actorUri],
      tag: [
        { type: "Mention", href: blockedActor },
        { type: "Mention", href: muted.actorUri },
      ],
    });
    const plain = await create(author, "https://rsn-mentions.example/notes/plain", {});

    expect(await statusNotifications("rsn-mentions-blocker@example.com", naming)).toBe(0);
    expect(await statusNotifications("rsn-mentions-muter@example.com", naming)).toBe(0);
    expect(await statusNotifications("rsn-mentions-blocker@example.com", plain)).toBe(1);
    expect(await statusNotifications("rsn-mentions-muter@example.com", plain)).toBe(1);
  });

  // `followers_for_local_distribution` keeps the followers whose user signed
  // in within `User::ACTIVE_DURATION` (7 days).
  it("goes to no follower who has not signed in for a week", async () => {
    const author = await remoteActor("rsninactive", "rsn-inactive.example");
    await followRemote("rsn-inactive-away@example.com", author, { notify: true });
    await followRemote("rsn-inactive-recent@example.com", author, { notify: true });
    const away = await signedInAccount("rsn-inactive-away@example.com");
    const recent = await signedInAccount("rsn-inactive-recent@example.com");
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("UPDATE account_activity_days SET day = ? WHERE account_id = ?").bind(
        daysAgo(8),
        away.id,
      ),
      env.DB.prepare("UPDATE account_activity_days SET day = ? WHERE account_id = ?").bind(
        daysAgo(6),
        recent.id,
      ),
    ]);

    const id = await create(author, "https://rsn-inactive.example/notes/1", {});

    expect(await statusNotifications("rsn-inactive-away@example.com", id)).toBe(0);
    expect(await statusNotifications("rsn-inactive-recent@example.com", id)).toBe(1);
  });

  it("goes to each notifying follower for a quote request's recent note, not for an old one", async () => {
    const author = await remoteActor("rsnquote", "rsn-quote.example");
    await followRemote("rsn-quote-notify@example.com", author, { notify: true });
    const quoted = z
      .object({ uri: z.string() })
      .parse(
        await call("rsn-quote-quoted@example.com", "/api/v1/statuses", { status: "quote me" }),
      );
    const request = async (slug: string, published: string): Promise<string> => {
      const uri = `https://rsn-quote.example/notes/${slug}`;
      expect(
        await author.send({
          id: `https://rsn-quote.example/quote_requests/${slug}`,
          type: "QuoteRequest",
          object: quoted.uri,
          instrument: {
            id: uri,
            type: "Note",
            attributedTo: author.actorUri,
            content: `<p>${slug}</p>`,
            published,
            to: [PUBLIC],
            cc: [`${author.actorUri}/followers`],
            quote: quoted.uri,
          },
        }),
      ).toBe(202);
      await settle();
      return storedId(uri);
    };

    const recent = await request("recent", new Date().toISOString());
    const old = await request("old", new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString());

    expect(await statusNotifications("rsn-quote-notify@example.com", recent)).toBe(1);
    expect(await statusNotifications("rsn-quote-notify@example.com", old)).toBe(0);
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
  // As Mastodon's `find_in_batches`, the followers are read a page at a
  // time: the inbox request reads the first and queues the next, so what it
  // sends the queue stays flat with the number of followers.
  it(
    "reads its notifying followers a page at a time through the queue",
    { timeout: 300_000 },
    async () => {
      const author = await remoteActor("rsnpages", "rsn-pages.example");
      const followers = Array.from(
        { length: NOTIFYING_FOLLOWER_PAGE_SIZE + 5 },
        (_, n) => `rsn-pages-${n}@example.com`,
      );
      for (const email of followers) {
        await followRemote(email, author, { notify: true });
      }
      const queued = holdQueue();
      const id = await create(author, "https://rsn-pages.example/notes/1", {});
      const recipientJobs = queued.bodies.filter(
        (body) => z.object({ kind: z.string() }).parse(body).kind === "FinishRemoteNoteRecipient",
      );
      expect(recipientJobs.length).toBe(NOTIFYING_FOLLOWER_PAGE_SIZE - INLINE_NOTE_RECIPIENTS);

      await drainHeld(queued, ["FinishRemoteNoteRecipient", "NotifyRemoteNoteFollowers"]);

      for (const email of followers) {
        expect(await statusNotifications(email, id), email).toBe(1);
      }
    },
  );

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

  it(
    "notifies a queued follower only if it still follows with notifications when its job runs",
    { timeout: 120_000 },
    async () => {
      const author = await remoteActor("rsnlate", "rsn-late.example");
      const followers = Array.from(
        { length: INLINE_NOTE_RECIPIENTS + 4 },
        (_, n) => `rsn-late-${n}@example.com`,
      );
      for (const email of followers) {
        await followRemote(email, author, { notify: true });
      }
      const queued = holdQueue();
      const id = await create(author, "https://rsn-late.example/notes/1", {});
      for (const email of followers) {
        await call(email, `/api/v1/accounts/${RemoteAccountId.encode(author.actorUri)}/follow`, {
          notify: false,
        });
      }
      await drainHeld(queued, ["FinishRemoteNoteRecipient"]);

      let notified = 0;
      for (const email of followers) {
        notified += await statusNotifications(email, id);
      }
      expect(notified).toBe(INLINE_NOTE_RECIPIENTS);
    },
  );

  it(
    "notifies a queued follower only if it does not mute an actor the note mentions when its job runs",
    { timeout: 120_000 },
    async () => {
      const author = await remoteActor("rsnlatemute", "rsn-late-mute.example");
      const named = await remoteActor("rsnlatemutenamed", "rsn-late-mute-named.example");
      const followers = Array.from(
        { length: INLINE_NOTE_RECIPIENTS + 4 },
        (_, n) => `rsn-late-mute-${n}@example.com`,
      );
      for (const email of followers) {
        await followRemote(email, author, { notify: true });
      }
      const queued = holdQueue();
      const id = await create(author, "https://rsn-late-mute.example/notes/1", {
        cc: [`${author.actorUri}/followers`, named.actorUri],
        tag: [{ type: "Mention", href: named.actorUri }],
      });
      for (const email of followers) {
        await call(email, `/api/v1/accounts/${RemoteAccountId.encode(named.actorUri)}/mute`, {});
      }
      await drainHeld(queued, ["FinishRemoteNoteRecipient"]);

      let notified = 0;
      for (const email of followers) {
        notified += await statusNotifications(email, id);
      }
      expect(notified).toBe(INLINE_NOTE_RECIPIENTS);
    },
  );
});

// Mastodon's `Create#distribute` fans out a status it fetched (a boosted
// one, a reply's parent, a quoted one, a search result) when it was
// published within `Status::REAL_TIME_WINDOW` (6 hours), so its notifying
// followers and the local accounts it mentions are notified as for one an
// inbox `Create` delivered.
describe("a followed remote actor's note this server fetches", () => {
  const boostedNote = async (slug: string, published: string) => {
    const author = await remoteActor(`rsnfetch${slug}`, `rsn-fetch-${slug}.example`);
    const booster = await remoteActor(
      `rsnfetchbooster${slug}`,
      `rsn-fetch-booster-${slug}.example`,
    );
    const follower = `rsn-fetch-${slug}-follower@example.com`;
    const mentioned = `rsn-fetch-${slug}-mentioned@example.com`;
    await followRemote(follower, author, { notify: true });
    await followRemote(follower, booster, {});
    const mentionedActor = await actorOf(mentioned);
    const uri = `https://rsn-fetch-${slug}.example/notes/1`;
    serve(
      new Map([
        [
          uri,
          {
            id: uri,
            type: "Note",
            attributedTo: author.actorUri,
            content: "<p>boost me</p>",
            published,
            to: [PUBLIC],
            cc: [`${author.actorUri}/followers`, mentionedActor],
            tag: [{ type: "Mention", href: mentionedActor }],
          },
        ],
      ]),
    );
    expect(
      await booster.send({
        id: `https://rsn-fetch-booster-${slug}.example/announces/1`,
        type: "Announce",
        actor: booster.actorUri,
        object: uri,
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${booster.actorUri}/followers`],
      }),
    ).toBe(202);
    await settle();
    return { id: await storedId(uri), follower, mentioned };
  };

  it("notifies when it was published within the real-time window", async () => {
    const { id, follower, mentioned } = await boostedNote(
      "recent",
      new Date(Date.now() - HOUR_MS).toISOString(),
    );

    expect(await statusNotifications(follower, id)).toBe(1);
    expect(await notificationsOf(mentioned, id, "mention")).toBe(1);
  });

  it("notifies nobody when it was published before the real-time window", async () => {
    const { id, follower, mentioned } = await boostedNote(
      "old",
      new Date(Date.now() - 7 * HOUR_MS).toISOString(),
    );

    expect(await statusNotifications(follower, id)).toBe(0);
    expect(await notificationsOf(mentioned, id, "mention")).toBe(0);
  });

  // Mastodon reads no outbox: the notes a profile view backfills from one
  // are never distributed there.
  it("notifies nobody when an outbox backfill stored it", async () => {
    const author = await remoteActor("rsnoutbox", "rsn-outbox.example");
    await followRemote("rsn-outbox-follower@example.com", author, { notify: true });
    const uri = "https://rsn-outbox.example/notes/1";
    const outbox = `${author.actorUri}/outbox`;
    serve(
      new Map<string, unknown>([
        [
          author.actorUri,
          {
            id: author.actorUri,
            type: "Person",
            preferredUsername: "rsnoutbox",
            inbox: `${author.actorUri}/inbox`,
            outbox,
            publicKey: {
              id: `${author.actorUri}#main-key`,
              owner: author.actorUri,
              publicKeyPem: author.publicKeyPem,
            },
          },
        ],
        [outbox, { id: outbox, type: "OrderedCollection", first: `${outbox}?page=true` }],
        [
          `${outbox}?page=true`,
          {
            id: `${outbox}?page=true`,
            type: "OrderedCollectionPage",
            orderedItems: [
              {
                id: `${uri}/activity`,
                type: "Create",
                actor: author.actorUri,
                to: [PUBLIC],
                cc: [`${author.actorUri}/followers`],
                object: {
                  id: uri,
                  type: "Note",
                  attributedTo: author.actorUri,
                  content: "<p>from the outbox</p>",
                  published: new Date(Date.now() - HOUR_MS).toISOString(),
                  to: [PUBLIC],
                  cc: [`${author.actorUri}/followers`],
                },
              },
            ],
          },
        ],
      ]),
    );
    const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri: author.actorUri });
    if (job.isErr()) {
      throw new Error("backfill job rejected");
    }
    expect(await processOutboxJob(env, job.value)).toBe("ok");
    await settle();

    expect(await statusNotifications("rsn-outbox-follower@example.com", await storedId(uri))).toBe(
      0,
    );
  });
});

/**
 * Makes D1 refuse to store a notification for `accountId` until the returned
 * function is called. `name` is the trigger's, one per test.
 */
const refuseNotifications = async (
  name: string,
  accountId: string,
): Promise<() => Promise<void>> => {
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON notifications
     WHEN NEW.account_id = '${accountId}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
};

// A distributed note's notifications are owed until they are sent, as an
// inbox `Create`'s are (`remote_status_owed`): a step that fails once is
// finished by the next activity that brings the note.
describe("a distributed note whose notifications failed once", () => {
  it("notifies when the boost that fetched it is delivered again", async () => {
    const author = await remoteActor("rsnretryfetch", "rsn-retry-fetch.example");
    const booster = await remoteActor("rsnretrybooster", "rsn-retry-booster.example");
    const email = "rsn-retry-fetch-follower@example.com";
    await followRemote(email, author, { notify: true });
    await followRemote(email, booster, {});
    const uri = "https://rsn-retry-fetch.example/notes/1";
    serve(
      new Map([
        [
          uri,
          {
            id: uri,
            type: "Note",
            attributedTo: author.actorUri,
            content: "<p>boost me</p>",
            published: new Date(Date.now() - HOUR_MS).toISOString(),
            to: [PUBLIC],
            cc: [`${author.actorUri}/followers`],
          },
        ],
      ]),
    );
    const announce = {
      id: "https://rsn-retry-booster.example/announces/1",
      type: "Announce",
      actor: booster.actorUri,
      object: uri,
      published: new Date().toISOString(),
      to: [PUBLIC],
      cc: [`${booster.actorUri}/followers`],
    };
    const allow = await refuseNotifications("rsn_retry_fetch", (await signedInAccount(email)).id);
    expect(await booster.send(announce)).toBeGreaterThanOrEqual(500);
    await settle();
    await allow();
    const id = await storedId(uri);
    expect(await statusNotifications(email, id)).toBe(0);

    expect(await booster.send(announce)).toBe(202);
    await settle();

    expect(await statusNotifications(email, id)).toBe(1);
  });

  // Mastodon decides once, when it creates the status, whether it is within
  // the real-time window; a retry hours later does not decide again.
  it("notifies when a quote request stored within the window is finished after it", async () => {
    const author = await remoteActor("rsnretryquote", "rsn-retry-quote.example");
    const email = "rsn-retry-quote-follower@example.com";
    await followRemote(email, author, { notify: true });
    const quoted = z.object({ uri: z.string() }).parse(
      await call("rsn-retry-quote-quoted@example.com", "/api/v1/statuses", {
        status: "quote me",
      }),
    );
    // Stored five hours after it was published, then finished two hours
    // later, past the window: the row and its marker are moved back after
    // the first delivery, as the clock cannot be.
    const published = new Date(Date.now() - 5 * HOUR_MS);
    const uri = "https://rsn-retry-quote.example/notes/1";
    const request = {
      id: "https://rsn-retry-quote.example/quote_requests/1",
      type: "QuoteRequest",
      object: quoted.uri,
      instrument: {
        id: uri,
        type: "Note",
        attributedTo: author.actorUri,
        content: "<p>quoting</p>",
        published: published.toISOString(),
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
        quote: quoted.uri,
      },
    };
    const allow = await refuseNotifications("rsn_retry_quote", (await signedInAccount(email)).id);
    expect(await author.send(request)).toBeGreaterThanOrEqual(500);
    await settle();
    await allow();
    const id = await storedId(uri);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE remote_statuses SET published_at = ? WHERE id = ?").bind(
        hoursAgo(7),
        id,
      ),
      env.DB.prepare("UPDATE remote_status_owed SET created_at = ? WHERE status_id = ?").bind(
        hoursAgo(2),
        id,
      ),
    ]);

    expect(await author.send(request)).toBe(202);
    await settle();

    expect(await statusNotifications(email, id)).toBe(1);
  });
});
