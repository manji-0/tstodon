import { SELF, env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { drainHeld, type HeldQueue, holdQueue, kindOf } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { settle } from "../test/meter";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
import { queueRemoteThreadResolve, THREAD_RESOLVE_HOP_LIMIT } from "./remote-thread-resolve";
import { parseInstanceIdentity } from "./runtime-config";

// Mastodon v4.7.5: a `Create` of a reply whose parent the server does not
// hold queues `ThreadResolveWorker`, which fetches the parent, links the
// reply to it and, for a reply published within the real-time window, runs
// `DistributionWorker` again with `skip_notifications`; `FeedInsertWorker`
// then sends a self-reply's `status` notification. The parent's own `Create`
// resolves its parent the same way, up to `DISCOVERIES_PER_REQUEST` statuses.

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const RESOLVE = "ResolveRemoteThread";

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

/** Follow `remote` as `email` with notifications, and have it accept. */
const followNotifying = async (email: string, remote: Remote): Promise<void> => {
  await call(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`, {
    notify: true,
  });
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

const storedId = async (objectUri: string): Promise<string | undefined> => {
  const [row] = parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  );
  return row?.id;
};

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

const ReplyRefs = z.object({
  in_reply_to_id: z.string().nullable(),
  in_reply_to_account_id: z.string().nullable(),
});

const replyRefs = async (email: string, statusId: string) =>
  ReplyRefs.parse(await call(email, `/api/v1/statuses/${statusId}`));

const note = (author: Remote, slug: string, fields: Record<string, unknown> = {}) => ({
  id: `${new URL(author.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: new Date().toISOString(),
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...fields,
});

type NoteDocument = ReturnType<typeof note>;

/** Have the note's author deliver its `Create`; the note's stored id. */
const deliver = async (author: Remote, object: NoteDocument): Promise<string> => {
  expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
  await settle();
  const id = await storedId(object.id);
  if (id === undefined) {
    throw new Error(`${object.id} was not stored`);
  }
  return id;
};

/** Every URL a `serving` fetch was asked for, in order. */
const fetchedUrls: string[] = [];

/**
 * Run `body` while `fetch` serves `documents` by id, fails as a server that
 * cannot be reached for each URL of `unreachable`, answers 503 for each of
 * `failing`, and 404s anything else.
 */
const serving = async <T>(
  documents: ReadonlyArray<Readonly<{ id: string }>>,
  body: () => Promise<T>,
  faults: Readonly<{ unreachable?: ReadonlyArray<string>; failing?: ReadonlyArray<string> }> = {},
): Promise<T> => {
  const byUrl = new Map(documents.map((document) => [document.id, document]));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(href);
    if (faults.unreachable?.includes(href)) {
      throw new TypeError("connection refused");
    }
    if (faults.failing?.includes(href)) {
      return new Response("unavailable", { status: 503 });
    }
    const document = byUrl.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
};

/** The thread jobs `held` holds, without taking them. */
const resolveJobs = (held: HeldQueue) => held.bodies.filter((body) => kindOf(body) === RESOLVE);

const resolveJob = (statusId: string, hop: number) => {
  const job = OutboxJob.parse({ kind: RESOLVE, statusId, hop });
  if (job.isErr()) {
    throw new Error("thread job rejected");
  }
  return job.value;
};

const drain = (held: HeldQueue) => drainHeld(held, [RESOLVE, "FinishRemoteNoteRecipient"]);

/**
 * `env` with each queue's sends recorded, not sent; `failPull` makes every
 * send to the pull queue throw, as a Queues outage, and `vars` replace
 * configured variables.
 */
const recordingEnv = ({
  failPull = false,
  vars = {},
}: Readonly<{ failPull?: boolean; vars?: Readonly<Record<string, string>> }> = {}) => {
  const pull: unknown[] = [];
  const outbox: unknown[] = [];
  const recorder = (into: unknown[], fails: boolean) => ({
    send: async (body: unknown) => {
      if (fails) {
        throw new Error("queue unavailable");
      }
      into.push(body);
    },
    sendBatch: async (messages: ReadonlyArray<{ body: unknown }>) => {
      if (fails) {
        throw new Error("queue unavailable");
      }
      into.push(...messages.map((message) => message.body));
    },
  });
  const queues: Record<string, unknown> = {
    ...vars,
    PULL_QUEUE: recorder(pull, failPull),
    OUTBOX_PROCESS_QUEUE: recorder(outbox, false),
  };
  const proxied = new Proxy(env, {
    get: (target, key) =>
      typeof key === "string" && key in queues ? queues[key] : Reflect.get(target, key),
  });
  return { env: proxied, pull, outbox };
};

describe("a remote reply whose parent this server does not hold", () => {
  it("is linked to the parent its job fetches, and a self-reply sends its status notification", async () => {
    const author = await remoteActor("rtrself", "rtr-self.example");
    const email = "rtr-self@example.com";
    await followNotifying(email, author);
    const parent = note(author, "root");
    const held = holdQueue();
    const reply = await deliver(author, note(author, "reply", { inReplyTo: parent.id }));

    expect(await statusNotifications(email, reply)).toBe(0);
    expect((await replyRefs(email, reply)).in_reply_to_id).toBeNull();
    expect(resolveJobs(held)).toHaveLength(1);

    await serving([parent], () => drain(held));

    const parentId = await storedId(parent.id);
    expect(parentId).toBeDefined();
    expect(await replyRefs(email, reply)).toEqual({
      in_reply_to_id: parentId,
      in_reply_to_account_id: RemoteAccountId.encode(author.actorUri),
    });
    expect(await statusNotifications(email, reply)).toBe(1);
    // The fetched root is recent, so its own `Create` distributes it too.
    expect(await statusNotifications(email, parentId ?? "")).toBe(1);

    // The queue delivers a job again: nothing is fetched or sent twice.
    held.bodies.push(resolveJob(reply, 1));
    await serving([], () => drain(held));
    expect(await statusNotifications(email, reply)).toBe(1);
    expect((await replyRefs(email, reply)).in_reply_to_id).toBe(parentId);
  });

  it("notifies nobody for a self-reply published before the real-time window", async () => {
    const author = await remoteActor("rtrold", "rtr-old.example");
    const email = "rtr-old@example.com";
    await followNotifying(email, author);
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const parent = note(author, "root", { published: old });
    const held = holdQueue();
    const reply = await deliver(
      author,
      note(author, "reply", { inReplyTo: parent.id, published: old }),
    );

    await serving([parent], () => drain(held));

    expect((await replyRefs(email, reply)).in_reply_to_id).toBe(await storedId(parent.id));
    expect(await statusNotifications(email, reply)).toBe(0);
  });

  it("notifies nobody for a reply to someone else", async () => {
    const author = await remoteActor("rtrother", "rtr-other.example");
    const other = await remoteActor("rtrotherparent", "rtr-other-parent.example");
    const email = "rtr-other@example.com";
    await followNotifying(email, author);
    const parent = note(other, "theirs");
    const held = holdQueue();
    const reply = await deliver(author, note(author, "reply", { inReplyTo: parent.id }));

    await serving([parent], () => drain(held));

    expect(await replyRefs(email, reply)).toEqual({
      in_reply_to_id: await storedId(parent.id),
      in_reply_to_account_id: RemoteAccountId.encode(other.actorUri),
    });
    expect(await statusNotifications(email, reply)).toBe(0);
  });

  it("carries the parent's reply account over a self-reply, as Mastodon's in_reply_to_account_id", async () => {
    const alice = await remoteActor("rtrcarry", "rtr-carry.example");
    const bob = await remoteActor("rtrcarrybob", "rtr-carry-bob.example");
    const email = "rtr-carry@example.com";
    await followNotifying(email, alice);
    const held = holdQueue();
    const theirs = note(bob, "theirs");
    await deliver(bob, theirs);
    const answer = note(alice, "answer", { inReplyTo: theirs.id });
    await deliver(alice, answer);
    const unlinked = note(alice, "unlinked", { inReplyTo: "https://rtr-carry-gone.example/n/1" });
    await deliver(alice, unlinked);
    const root = note(alice, "root");
    await deliver(alice, root);
    const second = note(alice, "second", { inReplyTo: root.id });
    await deliver(alice, second);

    // A → A → B, delivered with its parent stored.
    const underAnswer = await deliver(alice, note(alice, "under-answer", { inReplyTo: answer.id }));
    // A → A → (a parent not linked): Mastodon's in_reply_to_account_id is nil.
    const underUnlinked = await deliver(
      alice,
      note(alice, "under-unlinked", { inReplyTo: unlinked.id }),
    );
    // A → A → A.
    const third = await deliver(alice, note(alice, "third", { inReplyTo: second.id }));
    // A → A → B, its parent fetched by the thread job.
    const lateAnswer = note(alice, "late-answer", { inReplyTo: theirs.id });
    const underLate = await deliver(alice, note(alice, "under-late", { inReplyTo: lateAnswer.id }));
    held.bodies.splice(0, held.bodies.length, resolveJob(underLate, 1));
    await serving([lateAnswer], () => drain(held));

    expect(await statusNotifications(email, underAnswer)).toBe(0);
    expect(await statusNotifications(email, underUnlinked)).toBe(0);
    expect(await statusNotifications(email, third)).toBe(1);
    expect((await replyRefs(email, underLate)).in_reply_to_id).toBe(await storedId(lateAnswer.id));
    expect(await statusNotifications(email, underLate)).toBe(0);
  });

  it("queues no job when the parent is held", async () => {
    const author = await remoteActor("rtrheld", "rtr-held.example");
    const parent = note(author, "root");
    await deliver(author, parent);
    const held = holdQueue();

    await deliver(author, note(author, "reply", { inReplyTo: parent.id }));
    await deliver(
      author,
      note(author, "local", { inReplyTo: "https://example.com/users/x/statuses/1" }),
    );

    expect(resolveJobs(held)).toHaveLength(0);
  });

  it("resolves the chain above, one job a status, and stops at the limit", async () => {
    const author = await remoteActor("rtrchain", "rtr-chain.example");
    const email = "rtr-chain@example.com";
    await followNotifying(email, author);
    const root = note(author, "root");
    const middle = note(author, "middle", { inReplyTo: root.id });
    const held = holdQueue();
    const leaf = await deliver(author, note(author, "leaf", { inReplyTo: middle.id }));
    const [first] = held.bodies.splice(0).filter((body) => kindOf(body) === RESOLVE);

    // The leaf's job runs twice, as a redelivered message: the middle's job is queued once.
    await serving([middle], async () => {
      expect(await processOutboxJob(env, resolveJob(leaf, 1))).toBe("ok");
      expect(await processOutboxJob(env, resolveJob(leaf, 1))).toBe("ok");
    });
    const middleId = await storedId(middle.id);
    expect(first).toEqual({ kind: RESOLVE, statusId: leaf, hop: 1 });
    expect(resolveJobs(held)).toEqual([{ kind: RESOLVE, statusId: middleId, hop: 2 }]);

    await serving([root], () => drain(held));

    const rootId = await storedId(root.id);
    expect((await replyRefs(email, middleId ?? "")).in_reply_to_id).toBe(rootId);
    // The middle answers its author's root: Mastodon sends its notification
    // when its own job links it.
    expect(await statusNotifications(email, middleId ?? "")).toBe(1);

    const tail = note(author, "tail", { inReplyTo: note(author, "above-tail").id });
    const top = await deliver(author, note(author, "top", { inReplyTo: tail.id }));
    held.bodies.splice(0);
    await serving([tail], async () => {
      expect(await processOutboxJob(env, resolveJob(top, THREAD_RESOLVE_HOP_LIMIT))).toBe("ok");
    });
    expect(await storedId(tail.id)).toBeDefined();
    expect(resolveJobs(held)).toHaveLength(0);
  });

  it("queues its jobs on the pull queue, not the delivery queue, and gives a claim back when the send fails", async () => {
    const author = await remoteActor("rtrpull", "rtr-pull.example");
    const root = note(author, "root");
    const middle = note(author, "middle", { inReplyTo: root.id });
    holdQueue();
    const leaf = await deliver(author, note(author, "leaf", { inReplyTo: middle.id }));

    const failing = recordingEnv({ failPull: true });
    await serving([middle], async () => {
      expect(await processOutboxJob(failing.env, resolveJob(leaf, 1))).toBe("retry");
    });
    const recording = recordingEnv();
    await serving([], async () => {
      expect(await processOutboxJob(recording.env, resolveJob(leaf, 1))).toBe("ok");
    });

    expect(recording.pull).toEqual([
      { kind: RESOLVE, statusId: await storedId(middle.id), hop: 2 },
    ]);
    expect(
      [...failing.outbox, ...recording.outbox].filter((body) => kindOf(body) === RESOLVE),
    ).toEqual([]);
  });

  it("retries while the parent's server cannot be reached, and ends when the parent is gone", async () => {
    const author = await remoteActor("rtrdown", "rtr-down.example");
    const email = "rtr-down@example.com";
    await followNotifying(email, author);
    const parent = note(author, "root");
    holdQueue();
    const reply = await deliver(author, note(author, "reply", { inReplyTo: parent.id }));

    await serving(
      [],
      async () => {
        expect(await processOutboxJob(env, resolveJob(reply, 1))).toBe("retry");
      },
      { unreachable: [parent.id] },
    );
    await serving([], async () => {
      expect(await processOutboxJob(env, resolveJob(reply, 1))).toBe("ok");
    });

    expect((await replyRefs(email, reply)).in_reply_to_id).toBeNull();
    expect(await statusNotifications(email, reply)).toBe(0);
  });

  it("ends the job when the parent's server answers with an error", async () => {
    const author = await remoteActor("rtrfail", "rtr-fail.example");
    const email = "rtr-fail@example.com";
    await followNotifying(email, author);
    const parent = note(author, "root");
    holdQueue();
    const reply = await deliver(author, note(author, "reply", { inReplyTo: parent.id }));

    // As `FetchRemoteStatusService`, which reads any HTTP error as no status.
    await serving(
      [],
      async () => {
        expect(await processOutboxJob(env, resolveJob(reply, 1))).toBe("ok");
      },
      { failing: [parent.id] },
    );

    expect(fetchedUrls).toContain(parent.id);
    expect((await replyRefs(email, reply)).in_reply_to_id).toBeNull();
  });

  it("lets a claim whose job was lost expire after an hour", async () => {
    const author = await remoteActor("rtrstale", "rtr-stale.example");
    holdQueue();
    const reply = await deliver(
      author,
      note(author, "reply", { inReplyTo: "https://rtr-stale.example/notes/root" }),
    );
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("no instance identity");
    }
    const recording = recordingEnv();

    expect((await queueRemoteThreadResolve(recording.env, identity.value, reply, 1)).isOk()).toBe(
      true,
    );
    expect(recording.pull).toEqual([]);

    await env.DB.prepare("UPDATE remote_statuses SET thread_resolve_queued_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), reply)
      .run();
    expect((await queueRemoteThreadResolve(recording.env, identity.value, reply, 1)).isOk()).toBe(
      true,
    );
    expect(recording.pull).toEqual([{ kind: RESOLVE, statusId: reply, hop: 1 }]);
  });

  it("chains the hop before the limit", async () => {
    const author = await remoteActor("rtrlast", "rtr-last.example");
    const tail = note(author, "tail", { inReplyTo: note(author, "above-tail").id });
    holdQueue();
    const top = await deliver(author, note(author, "top", { inReplyTo: tail.id }));
    const recording = recordingEnv();

    await serving([tail], async () => {
      expect(
        await processOutboxJob(recording.env, resolveJob(top, THREAD_RESOLVE_HOP_LIMIT - 1)),
      ).toBe("ok");
    });

    expect(recording.pull).toEqual([
      { kind: RESOLVE, statusId: await storedId(tail.id), hop: THREAD_RESOLVE_HOP_LIMIT },
    ]);
  });

  it("notifies only the followers a direct self-reply names", async () => {
    const author = await remoteActor("rtrdirect", "rtr-direct.example");
    const named = "rtr-direct-named@example.com";
    const other = "rtr-direct-other@example.com";
    await followNotifying(named, author);
    await followNotifying(other, author);
    const namedUri = `https://example.com/users/${(await signedInAccount(named)).username}`;
    const parent = note(author, "root");
    const held = holdQueue();
    const reply = await deliver(
      author,
      note(author, "reply", {
        inReplyTo: parent.id,
        to: [namedUri],
        cc: [],
        tag: [{ type: "Mention", href: namedUri }],
      }),
    );

    await serving([parent], () => drain(held));

    expect((await replyRefs(named, reply)).in_reply_to_id).toBe(await storedId(parent.id));
    expect(await statusNotifications(named, reply)).toBe(1);
    expect(await statusNotifications(other, reply)).toBe(0);
  });

  it("fetches no parent on a suspended host, or off the allow-list under limited federation", async () => {
    const author = await remoteActor("rtrguard", "rtr-guard.example");
    const suspended = note(
      await remoteActor("rtrguardsusp", "rtr-guard-suspended.example"),
      "root",
    );
    const unlisted = note(await remoteActor("rtrguardlimit", "rtr-guard-unlisted.example"), "root");
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('rtr-guard-block', 'rtr-guard-suspended.example', 'suspend')",
    ).run();
    holdQueue();
    const underSuspended = await deliver(
      author,
      note(author, "under-suspended", { inReplyTo: suspended.id }),
    );
    const underUnlisted = await deliver(
      author,
      note(author, "under-unlisted", { inReplyTo: unlisted.id }),
    );
    const limited = recordingEnv({ vars: { FEDERATION_ALLOW_HOSTS: "rtr-guard.example" } });

    await serving([suspended, unlisted], async () => {
      expect(await processOutboxJob(env, resolveJob(underSuspended, 1))).toBe("ok");
      expect(await processOutboxJob(limited.env, resolveJob(underUnlisted, 1))).toBe("ok");
    });

    expect(fetchedUrls).not.toContain(suspended.id);
    expect(fetchedUrls).not.toContain(unlisted.id);
    expect(await storedId(suspended.id)).toBeUndefined();
    expect(await storedId(unlisted.id)).toBeUndefined();
  });

  it("queues the job of a quote request's instrument", async () => {
    const author = await remoteActor("rtrquote", "rtr-quote.example");
    const email = "rtr-quote-quoted@example.com";
    const quoted = await signedInAccount(email);
    const posted = z
      .object({ id: z.string() })
      .parse(await call(email, "/api/v1/statuses", { status: "quote me" }));
    const statusUri = `https://example.com/users/${quoted.username}/statuses/${posted.id}`;
    const instrument = note(author, "quoting", {
      inReplyTo: "https://rtr-quote.example/notes/unseen",
      quote: statusUri,
    });
    const held = holdQueue();

    expect(
      await author.send({
        id: `${author.actorUri}/quote_requests/1`,
        type: "QuoteRequest",
        object: statusUri,
        instrument,
      }),
    ).toBe(202);
    await settle();

    expect(resolveJobs(held)).toEqual([
      { kind: RESOLVE, statusId: await storedId(instrument.id), hop: 1 },
    ]);
  });

  // `FetchRemoteStatusService` runs the status as a `Create`, whose
  // `resolve_thread` does not look at when it was published.
  it("queues the job of a reply a boost made this server fetch, however old", async () => {
    const author = await remoteActor("rtrfetched", "rtr-fetched.example");
    const booster = await remoteActor("rtrfetchedbooster", "rtr-fetched-booster.example");
    const reply = note(author, "reply", {
      inReplyTo: note(author, "root").id,
      published: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    const held = holdQueue();

    await serving([reply], async () => {
      expect(
        await booster.send({
          id: `${booster.actorUri}/announces/1`,
          type: "Announce",
          object: reply.id,
          published: new Date().toISOString(),
          to: [PUBLIC],
        }),
      ).toBe(202);
    });
    await settle();

    expect(resolveJobs(held)).toEqual([
      { kind: RESOLVE, statusId: await storedId(reply.id), hop: 1 },
    ]);
  });

  // Mastodon reads no outbox, so nothing it stores comes from one.
  it("queues no job for a reply an outbox backfill stores", async () => {
    const author = await remoteActor("rtroutbox", "rtr-outbox.example");
    const reply = note(author, "reply", { inReplyTo: note(author, "root").id });
    const outbox = `${author.actorUri}/outbox`;
    const documents = [
      {
        id: author.actorUri,
        type: "Person",
        preferredUsername: "rtroutbox",
        inbox: `${author.actorUri}/inbox`,
        outbox,
        publicKey: {
          id: `${author.actorUri}#main-key`,
          owner: author.actorUri,
          publicKeyPem: author.publicKeyPem,
        },
      },
      { id: outbox, type: "OrderedCollection", first: `${outbox}?page=true` },
      {
        id: `${outbox}?page=true`,
        type: "OrderedCollectionPage",
        orderedItems: [
          { id: `${reply.id}/create`, type: "Create", actor: author.actorUri, object: reply },
        ],
      },
    ];
    const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri: author.actorUri });
    if (job.isErr()) {
      throw new Error("backfill job rejected");
    }
    const held = holdQueue();

    await serving(documents, async () => {
      expect(await processOutboxJob(env, job.value)).toBe("ok");
    });
    await settle();

    expect(await storedId(reply.id)).toBeDefined();
    expect(resolveJobs(held)).toEqual([]);
  });

  it("queues one job when the sender delivers the Create again after a 5xx", async () => {
    const author = await remoteActor("rtrredeliver", "rtr-redeliver.example");
    const held = holdQueue();
    const send = vi.spyOn(Object.getPrototypeOf(env.OUTBOX_PROCESS_QUEUE), "send");
    let refused = 0;
    send.mockImplementation((body: unknown) => {
      if (kindOf(body) === RESOLVE && refused === 0) {
        refused += 1;
        throw new Error("queue unavailable");
      }
      held.bodies.push(body);
    });
    const reply = note(author, "reply", { inReplyTo: "https://rtr-redeliver.example/notes/root" });
    const create = { id: `${reply.id}/create`, type: "Create", object: reply };

    expect(await author.send(create)).toBeGreaterThanOrEqual(500);
    expect(await author.send(create)).toBe(202);
    expect(await author.send({ ...create, id: `${reply.id}/create-again` })).toBe(202);
    await settle();

    expect(refused).toBe(1);
    expect(resolveJobs(held)).toEqual([
      { kind: RESOLVE, statusId: await storedId(reply.id), hop: 1 },
    ]);
  });
});
