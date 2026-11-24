import { createExecutionContext, env, SELF } from "cloudflare:test";
import type { OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { drainJobs, queueCapturingEnv } from "../test/queue-capture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { postInbox } from "./routes/activitypub";
import { FORWARD_MAX_ACCOUNTS } from "@tstodon/domain";
import { ok } from "neverthrow";
import { forwardRemoteActivity } from "./activity-forward";
import { findRemoteActorByUri } from "./remote-actor-store";
import { findRemoteStatusByObjectUri } from "./remote-status-store";
import { parseInstanceIdentity } from "./runtime-config";
import { remoteActivityForward } from "./status-reach";
import { statusReachOperations } from "./status-reach-operations";

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The inbox, run in this isolate with an outbox queue that keeps its jobs in `sent`. */
const capturingInbox = (sent: OutboxJob[]) => {
  const testEnv = queueCapturingEnv(sent);
  const app = new Hono<{ Bindings: Env }>();
  app.post("/inbox", postInbox);
  return {
    testEnv,
    post: async (request: Request): Promise<number> =>
      (await app.request(request, undefined, testEnv, createExecutionContext())).status,
  };
};

const api = async (email: string, path: string, body: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return schemaResult(z.object({ id: z.string() }))(await response.json())._unsafeUnwrap();
};

const actorOf = async (email: string): Promise<string> =>
  `${ORIGIN}/users/${(await signedInAccount(email)).username}`;

/** `follower` follows the local account (accepted at once: it is not locked). */
const followLocal = async (follower: Remote, email: string): Promise<void> => {
  const object = await actorOf(email);
  expect(
    await follower.send({ id: `${follower.actorUri}/follows/${email}`, type: "Follow", object }),
  ).toBe(202);
};

const note = (author: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `${author.actorUri}/statuses/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: new Date().toISOString(),
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...extra,
});

/** `author`'s own delivery of `activity`, with its Linked Data signature on it. */
const signedDelivery = async (author: Remote, activity: Record<string, unknown>) =>
  author.forward(await author.ldSigned(activity));

const forwardJobs = (sent: ReadonlyArray<OutboxJob>) =>
  sent.filter(
    (job): job is Extract<OutboxJob, { kind: "ExpandForward" }> => job.kind === "ExpandForward",
  );

/** The forwarded activity's row, and the inboxes its expansion delivers to. */
const expandForward = async (testEnv: Env, sent: OutboxJob[]) => {
  const [job] = forwardJobs(sent);
  if (job === undefined) {
    throw new Error("nothing was forwarded");
  }
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
  await drainJobs(testEnv, sent, "ExpandForward");
  const row = await env.DB.prepare(
    "SELECT account_id, kind, payload_json FROM outbound_activities WHERE id = ?",
  )
    .bind(job.activityId)
    .first<{ account_id: string; kind: string; payload_json: string }>();
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
  )
    .bind(job.activityId)
    .all<{ inbox_url: string }>();
  return {
    job,
    row,
    payload: JSON.parse(row?.payload_json ?? "null"),
    inboxes: results.map((target) => target.inbox_url),
  };
};

describe("forward_for_reply", () => {
  it("forwards a signed public reply to a local status to its author's remote followers", async () => {
    const author = "fwd-reply-author@example.com";
    const follower = await remoteActor("fwd-reply-follower", "fwd-reply-f.example");
    const alice = await remoteActor("fwd-reply-alice", "fwd-reply-a.example");
    await followLocal(follower, author);
    // The replier follows the author too: the forward leaves its own inbox out.
    await followLocal(alice, author);
    const status = await api(author, "/api/v1/statuses", { status: "reply to me" });
    const inReplyTo = `${await actorOf(author)}/statuses/${status.id}`;
    const sent: OutboxJob[] = [];
    const inbox = capturingInbox(sent);
    const reply = {
      id: `${alice.actorUri}/statuses/r1/activity`,
      type: "Create",
      to: [PUBLIC],
      object: note(alice, "r1", { inReplyTo }),
    };
    const signed = await alice.ldSigned(reply);
    expect(await inbox.post(await alice.forward(signed))).toBe(202);

    const forwarded = await expandForward(inbox.testEnv, sent);
    expect(forwarded.job.exceptInboxes).toEqual([`${alice.actorUri}/inbox`]);
    expect(forwarded.row).toMatchObject({
      account_id: (await signedInAccount(author)).id,
      kind: "Create",
    });
    // The body as received, its signature with it.
    expect(forwarded.payload).toEqual(signed);
    expect(forwarded.inboxes).toEqual([`${follower.actorUri}/inbox`]);
  });

  it("does not forward what Mastodon does not", async () => {
    const author = "fwd-none-author@example.com";
    const follower = await remoteActor("fwd-none-follower", "fwd-none-f.example");
    const alice = await remoteActor("fwd-none-alice", "fwd-none-a.example");
    await followLocal(follower, author);
    const status = await api(author, "/api/v1/statuses", { status: "no forwards" });
    const inReplyTo = `${await actorOf(author)}/statuses/${status.id}`;
    const remoteParent = note(alice, "parent");
    expect(
      await alice.send({ id: `${remoteParent.id}/activity`, type: "Create", object: remoteParent }),
    ).toBe(202);
    const sent: OutboxJob[] = [];
    const inbox = capturingInbox(sent);
    const create = (slug: string, object: Record<string, unknown>) => ({
      id: `${alice.actorUri}/statuses/${slug}/activity`,
      type: "Create",
      to: object["to"],
      object,
    });
    // Unsigned: the receivers would have nothing to check.
    expect(
      await inbox.post(
        await alice.delivery(create("unsigned", note(alice, "unsigned", { inReplyTo }))),
      ),
    ).toBe(202);
    // Followers-only: not distributable.
    const restricted = note(alice, "restricted", {
      inReplyTo,
      to: [`${alice.actorUri}/followers`],
      cc: [],
    });
    expect(await inbox.post(await signedDelivery(alice, create("restricted", restricted)))).toBe(
      202,
    );
    // A reply to a remote status.
    expect(
      await inbox.post(
        await signedDelivery(
          alice,
          create("remote", note(alice, "remote", { inReplyTo: remoteParent.id })),
        ),
      ),
    ).toBe(202);
    // A note this server already had: a second Create of it stores nothing new.
    const known = note(alice, "known", { inReplyTo });
    expect(await alice.send(create("known", known))).toBe(202);
    expect(
      await inbox.post(
        await signedDelivery(alice, { ...create("known", known), id: `${known.id}/again` }),
      ),
    ).toBe(202);
    expect(forwardJobs(sent)).toEqual([]);
  });
});

describe("forwarding a remote status's Update and Delete to its local sharers' followers", () => {
  it("forwards them to the followers of the local account that boosted it", async () => {
    const booster = "fwd-boost-booster@example.com";
    const follower = await remoteActor("fwd-boost-follower", "fwd-boost-f.example", {
      sharedInboxUri: "https://fwd-boost-f.example/inbox",
    });
    const carol = await remoteActor("fwd-boost-carol", "fwd-boost-c.example");
    await followLocal(follower, booster);
    const boosted = note(carol, "boosted");
    expect(
      await carol.send({ id: `${boosted.id}/activity`, type: "Create", object: boosted }),
    ).toBe(202);
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(boosted.id)
      .first<{ id: string }>();
    await api(booster, `/api/v1/statuses/${row?.id}/reblog`, {});
    const boosterId = (await signedInAccount(booster)).id;

    const editSent: OutboxJob[] = [];
    const editInbox = capturingInbox(editSent);
    const update = {
      id: `${boosted.id}#updates/1`,
      type: "Update",
      to: [PUBLIC],
      object: {
        ...boosted,
        content: "<p>edited</p>",
        updated: new Date(Date.now() + 1000).toISOString(),
      },
    };
    expect(await editInbox.post(await signedDelivery(carol, update))).toBe(202);
    const edit = await expandForward(editInbox.testEnv, editSent);
    expect(edit.row).toMatchObject({ account_id: boosterId, kind: "Update" });
    expect(edit.inboxes).toEqual(["https://fwd-boost-f.example/inbox"]);

    const deleteSent: OutboxJob[] = [];
    const deleteInbox = capturingInbox(deleteSent);
    const remove = {
      id: `${boosted.id}#delete`,
      type: "Delete",
      to: [PUBLIC],
      object: { id: boosted.id, type: "Tombstone" },
    };
    const signed = await carol.ldSigned(remove);
    expect(await deleteInbox.post(await carol.forward(signed))).toBe(202);
    const deleted = await expandForward(deleteInbox.testEnv, deleteSent);
    expect(deleted.row).toMatchObject({ account_id: boosterId, kind: "Delete" });
    expect(deleted.payload).toEqual(signed);
    expect(deleted.inboxes).toEqual(["https://fwd-boost-f.example/inbox"]);
    // The status is gone, and so is the boost.
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM remote_statuses WHERE object_uri = ?",
    )
      .bind(boosted.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("does not forward an unsigned Delete, nor one of a status nobody here shared", async () => {
    const booster = "fwd-quiet-booster@example.com";
    const follower = await remoteActor("fwd-quiet-follower", "fwd-quiet-f.example");
    const carol = await remoteActor("fwd-quiet-carol", "fwd-quiet-c.example");
    await followLocal(follower, booster);
    const boosted = note(carol, "boosted");
    const lonely = note(carol, "lonely");
    for (const object of [boosted, lonely]) {
      expect(await carol.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
    }
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(boosted.id)
      .first<{ id: string }>();
    await api(booster, `/api/v1/statuses/${row?.id}/reblog`, {});
    const sent: OutboxJob[] = [];
    const inbox = capturingInbox(sent);
    const remove = (object: Record<string, unknown>) => ({
      id: `${String(object["id"])}#delete`,
      type: "Delete",
      to: [PUBLIC],
      object: { id: object["id"], type: "Tombstone" },
    });
    expect(await inbox.post(await carol.delivery(remove(boosted)))).toBe(202);
    expect(await inbox.post(await signedDelivery(carol, remove(lonely)))).toBe(202);
    expect(forwardJobs(sent)).toEqual([]);
  });
});

describe("forwarding once, the replied-to author first", () => {
  it("forwards once however often its handling runs, and keeps the replied-to author", async () => {
    const author = "fwd-once-author@example.com";
    const follower = await remoteActor("fwd-once-follower", "fwd-once-f.example");
    const alice = await remoteActor("fwd-once-alice", "fwd-once-a.example");
    await followLocal(follower, author);
    const status = await api(author, "/api/v1/statuses", { status: "once" });
    const inReplyTo = `${await actorOf(author)}/statuses/${status.id}`;
    const signed = await alice.ldSigned({
      id: `${alice.actorUri}/statuses/once/activity`,
      type: "Create",
      to: [PUBLIC],
      object: note(alice, "once", { inReplyTo }),
    });
    const sent: OutboxJob[] = [];
    const inbox = capturingInbox(sent);
    expect(await inbox.post(await alice.forward(signed))).toBe(202);
    expect(forwardJobs(sent)).toHaveLength(1);

    // The late steps of the same delivery, run again by a retry while the
    // first expansion was never queued (a lost queue send): queued again,
    // for the same stored forward.
    const stored = (
      await findRemoteStatusByObjectUri(env.DB, `${alice.actorUri}/statuses/once`)
    )._unsafeUnwrap();
    const actor = (await findRemoteActorByUri(env.DB, alice.actorUri))._unsafeUnwrap();
    if (stored === undefined || actor === undefined) {
      throw new Error("the reply was not stored");
    }
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const retry = () =>
      forwardRemoteActivity(inbox.testEnv, identity, stored, actor, {
        kind: "Create",
        body: signed,
      });
    const [first] = forwardJobs(sent);
    sent.length = 0;
    await retry();
    expect(forwardJobs(sent).map((job) => job.activityId)).toEqual([first?.activityId]);
    // Once expanded, a retry queues nothing.
    await expandForward(inbox.testEnv, sent);
    await retry();
    expect(forwardJobs(sent)).toEqual([]);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbound_activities WHERE forward_of = ?",
    )
      .bind(signed["id"])
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // However many local accounts shared it, the replied-to author is kept.
    const authorId = (await signedInAccount(author)).id;
    const plan = await remoteActivityForward(
      {
        ...statusReachOperations(env, identity),
        listLocalSharerAccountIds: async (_status, limit) =>
          ok(Array.from({ length: limit }, (_, i) => `sharer-${i}`)),
      },
      { kind: "Remote", status: stored },
      FORWARD_MAX_ACCOUNTS,
    );
    const planned = plan._unsafeUnwrap();
    expect(planned?.signerAccountId).toBe(authorId);
    expect(planned?.followersOf[0]).toBe(authorId);
    expect(planned?.followersOf).toHaveLength(FORWARD_MAX_ACCOUNTS);
  });
});

describe("forwarding a quote stamp's Delete", () => {
  /**
   * Bob quotes Carol's note with her stamp; `follower` is a remote actor for
   * the test to have follow a local account. `bobExtra` changes Bob's note.
   */
  const stampSetup = async (slug: string, bobExtra: Record<string, unknown> = {}) => {
    const carol = await remoteActor(`${slug}-carol`, `${slug}-c.example`);
    const bob = await remoteActor(`${slug}-bob`, `${slug}-b.example`);
    const follower = await remoteActor(`${slug}-follower`, `${slug}-f.example`);
    const carolNote = note(carol, "quoted");
    expect(
      await carol.send({ id: `${carolNote.id}/activity`, type: "Create", object: carolNote }),
    ).toBe(202);
    const stampUri = `${carol.actorUri}/stamps/${slug}`;
    const bobNote = note(bob, "quoting", {
      quote: carolNote.id,
      quoteAuthorization: stampUri,
      interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
      ...bobExtra,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      new Request(input, init).url === stampUri
        ? Response.json({
            "@context": "https://www.w3.org/ns/activitystreams",
            id: stampUri,
            type: "QuoteAuthorization",
            attributedTo: carol.actorUri,
            interactingObject: bobNote.id,
            interactionTarget: carolNote.id,
          })
        : new Response(null, { status: 202 }),
    );
    expect(await bob.send({ id: `${bobNote.id}/activity`, type: "Create", object: bobNote })).toBe(
      202,
    );
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(bobNote.id)
      .first<{ id: string }>();
    if (row === null) {
      throw new Error("Bob's note was not stored");
    }
    const revoke = async () => {
      const signed = await carol.ldSigned({
        id: `${stampUri}#delete`,
        type: "Delete",
        to: [PUBLIC],
        object: { id: stampUri, type: "QuoteAuthorization" },
      });
      const sent: OutboxJob[] = [];
      const inbox = capturingInbox(sent);
      expect(await inbox.post(await carol.forward(signed))).toBe(202);
      return { signed, sent, testEnv: inbox.testEnv };
    };
    return { follower, bobNoteId: row.id, revoke };
  };

  it("reaches the followers of the local accounts that quoted the quoting status", async () => {
    const quoter = "fwd-stamp-quoter@example.com";
    const stamp = await stampSetup("fwd-stamp");
    await followLocal(stamp.follower, quoter);
    await api(quoter, "/api/v1/statuses", {
      status: "quoting Bob",
      quoted_status_id: stamp.bobNoteId,
    });

    const revoked = await stamp.revoke();

    const forwarded = await expandForward(revoked.testEnv, revoked.sent);
    expect(forwarded.row).toMatchObject({
      account_id: (await signedInAccount(quoter)).id,
      kind: "Delete",
    });
    expect(forwarded.payload).toEqual(revoked.signed);
    expect(forwarded.inboxes).toEqual([`${stamp.follower.actorUri}/inbox`]);
  });

  it("reaches the replied-to author's followers whatever the quoting status's visibility", async () => {
    // `Delete#revoke_quote` forwards without asking `Forwarder#forwardable?`.
    const author = "fwd-stamp-private-author@example.com";
    const status = await api(author, "/api/v1/statuses", { status: "reply to me" });
    const authorUri = await actorOf(author);
    const stamp = await stampSetup("fwd-stamp-private", {
      inReplyTo: `${authorUri}/statuses/${status.id}`,
      to: [authorUri],
      cc: [],
      tag: [{ type: "Mention", href: authorUri }],
    });
    await followLocal(stamp.follower, author);

    const revoked = await stamp.revoke();

    const forwarded = await expandForward(revoked.testEnv, revoked.sent);
    expect(forwarded.row).toMatchObject({
      account_id: (await signedInAccount(author)).id,
      kind: "Delete",
    });
    expect(forwarded.inboxes).toEqual([`${stamp.follower.actorUri}/inbox`]);
  });
});
