import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { ActivityId, OutboxDelivery, OutboxJob, QuoteRetry } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { attemptInboxDelivery } from "./delivery";
import { processOutboxJob } from "./outbox-job";
import { requestQuoteRefresh } from "./quote-retry-queue";
import { findRemoteActorByUri } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";
import { parseInstanceIdentity } from "./runtime-config";
import { unsignedFetch } from "./federated-fetch";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

type Sent = Readonly<{ message: unknown; delaySeconds: number | undefined }>;

const SendOptionsSchema = z.object({ delaySeconds: z.number().optional() }).optional();

/** The test `Env` with its queue recorded, and `vars` in place of string variables. */
const recordingEnv = (vars: Readonly<Record<string, string>> = {}) => {
  const sent: Sent[] = [];
  const queue = {
    send: async (message: unknown, options?: unknown) => {
      sent.push({ message, delaySeconds: read(SendOptionsSchema, options)?.delaySeconds });
    },
    sendBatch: async (messages: ReadonlyArray<{ body: unknown }>) => {
      sent.push(...messages.map((message) => ({ message: message.body, delaySeconds: undefined })));
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) =>
      key === "OUTBOX_PROCESS_QUEUE"
        ? queue
        : typeof key === "string" && key in vars
          ? vars[key]
          : Reflect.get(target, key),
  });
  return { env: proxied, sent };
};

type Recording = ReturnType<typeof recordingEnv>;

/** The recorded jobs of one kind. */
const jobsOf = (recording: Recording, kind: string) =>
  recording.sent.filter(
    (entry) =>
      typeof entry.message === "object" &&
      entry.message !== null &&
      Reflect.get(entry.message, "kind") === kind,
  );

const runJob = async (recording: Recording, message: unknown) => {
  const job = OutboxJob.parse(message);
  if (job.isErr()) {
    throw new Error(`job rejected: ${JSON.stringify(message)}`);
  }
  return processOutboxJob(recording.env, job.value);
};

const SERVER_ERROR = Symbol("500");

/**
 * The URLs the worker fetched, while the stub serves each `served` body as
 * JSON (a 500 for {@link SERVER_ERROR}) and anything else as a 404.
 */
const stubFetch = (served: Record<string, unknown>): string[] => {
  vi.restoreAllMocks();
  const fetched: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    fetched.push(url);
    const body = served[url];
    if (body === undefined || body === SERVER_ERROR) {
      return new Response(null, { status: body === undefined ? 404 : 500 });
    }
    return Response.json(body);
  });
  return fetched;
};

afterEach(() => {
  vi.restoreAllMocks();
});

const note = (author: Remote, uri: string, extra: Record<string, unknown> = {}) => ({
  id: uri,
  type: "Note",
  attributedTo: author.actorUri,
  content: "<p>hello</p>",
  published: "2026-11-01T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...extra,
});

const QuoteRowSchema = z.object({
  id: z.string(),
  remote_status_id: z.string(),
  quoted_remote_status_id: z.string().nullable(),
  quoted_uri: z.string().nullable(),
  state: z.string(),
  approval_uri: z.string().nullable(),
  updated_at: z.string(),
});

const remoteStatusId = async (objectUri: string): Promise<string | undefined> => {
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first();
  return row === null ? undefined : read(z.object({ id: z.string() }), row).id;
};

/**
 * Bob (remote.example) quotes a note by Carol (other.example) with her
 * stamp. `store` stores Bob's note in-process, so the queued jobs can be
 * observed.
 */
const setup = async (slug: string) => {
  const bob = await remoteActor(`${slug}-bob`);
  const carol = await remoteActor(`${slug}-carol`, "other.example");
  const carolNote = note(carol, `https://other.example/notes/${slug}`);
  const bobNoteUri = `https://remote.example/notes/${slug}`;
  const stampUri = `${carol.actorUri}/stamps/${slug}`;
  const stamp = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: stampUri,
    type: "QuoteAuthorization",
    attributedTo: carol.actorUri,
    interactingObject: bobNoteUri,
    interactionTarget: carolNote.id,
  };
  const store = async (recording: Recording) => {
    const identity = parseInstanceIdentity(env);
    const actor = await findRemoteActorByUri(env.DB, bob.actorUri);
    if (identity.isErr() || actor.isErr() || !actor.value) {
      throw new Error("fixture rejected");
    }
    const stored = await persistRemoteObject(
      recording.env,
      identity.value,
      actor.value,
      note(bob, bobNoteUri, { quote: carolNote.id, quoteAuthorization: stampUri }),
      { fetchSigner: unsignedFetch },
    );
    expect(stored.isOk()).toBe(true);
  };
  const quoteRow = async () => {
    const row = await env.DB.prepare(
      `SELECT q.id, q.remote_status_id, q.quoted_remote_status_id, q.quoted_uri, q.state,
         q.approval_uri, q.updated_at
       FROM status_quotes q JOIN remote_statuses r ON r.id = q.remote_status_id
       WHERE r.object_uri = ?`,
    )
      .bind(bobNoteUri)
      .first();
    return read(QuoteRowSchema, row);
  };
  return { bob, carol, carolNote, bobNoteUri, stampUri, stamp, store, quoteRow };
};

type Setup = Awaited<ReturnType<typeof setup>>;

/** The one refetch job a step queued, checked against `attempt`'s delay bounds. */
const queuedRefetch = (recording: Recording, attempt: number) => {
  const jobs = jobsOf(recording, "RefetchAndVerifyQuote");
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  expect(job?.message).toEqual(expect.objectContaining({ attempt }));
  expect(job?.delaySeconds).toBeGreaterThanOrEqual(QuoteRetry.refetchDelaySeconds(attempt, 0));
  expect(job?.delaySeconds).toBeLessThanOrEqual(QuoteRetry.refetchDelaySeconds(attempt, 0.999999));
  return job?.message;
};

const announcedUpdate = (recording: Recording, statusId: string) =>
  expect(jobsOf(recording, "FanOutHome")).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ event: "status.update", entryId: statusId }),
    }),
  );

describe("RefetchAndVerifyQuote (Mastodon's RefetchAndVerifyQuoteWorker)", () => {
  it("queues a refetch when the stamp fetch fails for now; a later run accepts the quote", async () => {
    const q = await setup("qr-stamp-later");
    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: SERVER_ERROR });
    const storing = recordingEnv();
    await q.store(storing);

    const before = await q.quoteRow();
    expect(before.state).toBe("pending");
    expect(before.quoted_remote_status_id).toBe(await remoteStatusId(q.carolNote.id));
    const message = queuedRefetch(storing, 1);
    expect(message).toEqual({
      kind: "RefetchAndVerifyQuote",
      quoteId: before.id,
      quotedUri: q.carolNote.id,
      approvalUri: q.stampUri,
      attempt: 1,
    });

    stubFetch({ [q.stampUri]: q.stamp });
    const running = recordingEnv();
    expect(await runJob(running, message)).toBe("ok");

    const after = await q.quoteRow();
    expect(after).toEqual(
      expect.objectContaining({ id: before.id, state: "accepted", approval_uri: q.stampUri }),
    );
    expect(jobsOf(running, "RefetchAndVerifyQuote")).toEqual([]);
    announcedUpdate(running, after.remote_status_id);
  });

  it("queues a refetch when the quoted note does not resolve; a later run resolves it", async () => {
    const q = await setup("qr-note-later");
    stubFetch({ [q.carolNote.id]: SERVER_ERROR, [q.stampUri]: SERVER_ERROR });
    const storing = recordingEnv();
    await q.store(storing);
    const before = await q.quoteRow();
    expect(before).toEqual(
      expect.objectContaining({ quoted_uri: q.carolNote.id, state: "pending" }),
    );
    const message = queuedRefetch(storing, 1);

    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: q.stamp });
    const running = recordingEnv();
    expect(await runJob(running, message)).toBe("ok");

    expect(await q.quoteRow()).toEqual(
      expect.objectContaining({
        id: before.id,
        quoted_uri: null,
        quoted_remote_status_id: await remoteStatusId(q.carolNote.id),
        state: "accepted",
      }),
    );
    announcedUpdate(running, before.remote_status_id);
  });

  it("gives up after four attempts", async () => {
    const q = await setup("qr-bounded");
    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: SERVER_ERROR });
    const storing = recordingEnv();
    await q.store(storing);
    let message = queuedRefetch(storing, 1);

    for (const attempt of [2, 3, 4]) {
      const running = recordingEnv();
      expect(await runJob(running, message)).toBe("ok");
      message = queuedRefetch(running, attempt);
      // A run that changes nothing announces nothing.
      expect(jobsOf(running, "FanOutHome")).toEqual([]);
    }
    const last = recordingEnv();
    expect(await runJob(last, message)).toBe("ok");

    expect(jobsOf(last, "RefetchAndVerifyQuote")).toEqual([]);
    expect((await q.quoteRow()).state).toBe("pending");
  });

  it("rejects the quote without another attempt when the stamp no longer resolves", async () => {
    const q = await setup("qr-gone");
    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: SERVER_ERROR });
    const storing = recordingEnv();
    await q.store(storing);
    const message = queuedRefetch(storing, 1);

    stubFetch({});
    const running = recordingEnv();
    expect(await runJob(running, message)).toBe("ok");

    const after = await q.quoteRow();
    expect(after.state).toBe("rejected");
    expect(jobsOf(running, "RefetchAndVerifyQuote")).toEqual([]);
    announcedUpdate(running, after.remote_status_id);
  });

  it("queues nothing for a stamp that resolves but does not match", async () => {
    const q = await setup("qr-mismatch");
    stubFetch({
      [q.carolNote.id]: q.carolNote,
      [q.stampUri]: { ...q.stamp, interactingObject: "https://remote.example/notes/other" },
    });
    const storing = recordingEnv();
    await q.store(storing);

    expect((await q.quoteRow()).state).toBe("pending");
    expect(jobsOf(storing, "RefetchAndVerifyQuote")).toEqual([]);
  });

  const queuedFor = async (q: Setup) => {
    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: SERVER_ERROR });
    const storing = recordingEnv();
    await q.store(storing);
    return queuedRefetch(storing, 1);
  };

  it("drops a job for a quote that was resolved meanwhile", async () => {
    const q = await setup("qr-resolved");
    const message = await queuedFor(q);
    await env.DB.prepare("UPDATE status_quotes SET state = 'rejected' WHERE id = ?")
      .bind((await q.quoteRow()).id)
      .run();
    const fetched = stubFetch({ [q.stampUri]: q.stamp });
    const running = recordingEnv();

    expect(await runJob(running, message)).toBe("ok");

    expect(fetched).toEqual([]);
    expect((await q.quoteRow()).state).toBe("rejected");
    expect(running.sent).toEqual([]);
  });

  it("drops a job for a quote that is gone", async () => {
    const q = await setup("qr-deleted");
    const message = await queuedFor(q);
    await env.DB.prepare("DELETE FROM status_quotes WHERE id = ?")
      .bind((await q.quoteRow()).id)
      .run();
    const fetched = stubFetch({ [q.stampUri]: q.stamp });
    const running = recordingEnv();

    expect(await runJob(running, message)).toBe("ok");

    expect(fetched).toEqual([]);
    expect(running.sent).toEqual([]);
  });

  it("drops a job for a quoted note the quote no longer names", async () => {
    const q = await setup("qr-moved");
    const message = await queuedFor(q);
    const fetched = stubFetch({ [q.stampUri]: q.stamp });
    const running = recordingEnv();

    expect(
      await runJob(running, {
        ...read(z.record(z.string(), z.unknown()), message),
        quotedUri: "https://other.example/notes/qr-moved-elsewhere",
      }),
    ).toBe("ok");

    expect(fetched).toEqual([]);
    expect((await q.quoteRow()).state).toBe("pending");
  });

  it("drops a job for a quoting author outside the federation allow list", async () => {
    const q = await setup("qr-not-allowed");
    const message = await queuedFor(q);
    const fetched = stubFetch({ [q.stampUri]: q.stamp });
    const running = recordingEnv({ FEDERATION_ALLOW_HOSTS: "other.example" });

    expect(await runJob(running, message)).toBe("ok");

    expect(fetched).toEqual([]);
    expect((await q.quoteRow()).state).toBe("pending");
  });
});

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** Bob's quote of Carol's note, accepted on her stamp and last checked `days` ago. */
const acceptedQuote = async (slug: string, days: number) => {
  const q = await setup(slug);
  stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: q.stamp });
  await q.store(recordingEnv());
  const row = await q.quoteRow();
  expect(row.state).toBe("accepted");
  await env.DB.prepare("UPDATE status_quotes SET updated_at = ? WHERE id = ?")
    .bind(daysAgo(days), row.id)
    .run();
  return { ...q, quoteId: row.id, statusId: row.remote_status_id };
};

describe("RefreshQuote (Mastodon's QuoteRefreshWorker)", () => {
  it("is queued once for an accepted quote last checked over a week ago", async () => {
    const q = await acceptedQuote("qr-refresh-stale", 8);
    const first = recordingEnv();

    await requestQuoteRefresh(first.env, q.statusId);

    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.message).toEqual({ kind: "RefreshQuote", quoteId: q.quoteId });
    expect(first.sent[0]?.delaySeconds).toBeGreaterThanOrEqual(0);
    expect(first.sent[0]?.delaySeconds).toBeLessThan(6 * 60 * 60);
    expect(Date.parse((await q.quoteRow()).updated_at)).toBeGreaterThan(Date.parse(daysAgo(1)));
    const second = recordingEnv();
    await requestQuoteRefresh(second.env, q.statusId);
    expect(second.sent).toEqual([]);
  });

  it("is not queued for a quote checked within the week, or one not accepted", async () => {
    const fresh = await acceptedQuote("qr-refresh-fresh", 6);
    const pending = await acceptedQuote("qr-refresh-pending", 8);
    await env.DB.prepare(
      "UPDATE status_quotes SET state = 'pending', approval_uri = NULL WHERE id = ?",
    )
      .bind(pending.quoteId)
      .run();
    const recording = recordingEnv();

    await requestQuoteRefresh(recording.env, fresh.statusId);
    await requestQuoteRefresh(recording.env, pending.statusId);

    expect(recording.sent).toEqual([]);
  });

  it("is claimed when the stale quoting status is shown", async () => {
    const q = await acceptedQuote("qr-refresh-shown", 8);
    const email = "qr-refresh-shown-viewer@example.com";
    await signedInAccount(email);

    const response = await SELF.fetch(`https://example.com/api/v1/statuses/${q.statusId}`, {
      headers: await authHeaders(email),
    });

    expect(response.status).toBe(200);
    expect(Date.parse((await q.quoteRow()).updated_at)).toBeGreaterThan(Date.parse(daysAgo(1)));
  });

  it("revokes a quote whose stamp no longer resolves", async () => {
    const q = await acceptedQuote("qr-refresh-revoked", 8);
    const fetched = stubFetch({});
    const running = recordingEnv();

    expect(await runJob(running, { kind: "RefreshQuote", quoteId: q.quoteId })).toBe("ok");

    expect(fetched).toEqual([q.stampUri]);
    expect((await q.quoteRow()).state).toBe("revoked");
    announcedUpdate(running, q.statusId);
  });

  it.each([
    ["still resolves", "stamp"],
    ["cannot be fetched for now", "error"],
  ] as const)("keeps a quote whose stamp %s", async (_, served) => {
    const q = await acceptedQuote(`qr-refresh-kept-${served}`, 8);
    const fetched = stubFetch({ [q.stampUri]: served === "stamp" ? q.stamp : SERVER_ERROR });
    const running = recordingEnv();

    expect(await runJob(running, { kind: "RefreshQuote", quoteId: q.quoteId })).toBe("ok");

    expect(fetched).toEqual([q.stampUri]);
    expect((await q.quoteRow()).state).toBe("accepted");
    expect(running.sent).toEqual([]);
  });

  it("does not fetch a stamp on a host outside the federation allow list", async () => {
    const q = await acceptedQuote("qr-refresh-not-allowed", 8);
    const fetched = stubFetch({});
    const running = recordingEnv({ FEDERATION_ALLOW_HOSTS: "remote.example" });

    expect(await runJob(running, { kind: "RefreshQuote", quoteId: q.quoteId })).toBe("ok");

    expect(fetched).toEqual([]);
    expect((await q.quoteRow()).state).toBe("accepted");
  });
});

describe("our QuoteRequest (Mastodon's QuoteRequestWorker)", () => {
  it("goes out as an outbox delivery that a failed attempt retries", async () => {
    const email = "qr-request-alice@example.com";
    const alice = await signedInAccount(email);
    const bob = await remoteActor("qr-request-bob");
    const bobNote = note(bob, "https://remote.example/notes/qr-request", {
      interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
    });
    expect(await bob.send({ id: `${bobNote.id}/activity`, type: "Create", object: bobNote })).toBe(
      202,
    );
    stubFetch({});
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({
        status: "quoting",
        quoted_status_id: await remoteStatusId(bobNote.id),
      }),
    });
    expect(posted.status).toBe(200);
    const request = read(
      z.object({ id: z.string() }),
      await env.DB.prepare(
        "SELECT id FROM outbound_activities WHERE account_id = ? AND kind = 'QuoteRequest'",
      )
        .bind(alice.id)
        .first(),
    );
    const activityId = ActivityId.parse(request.id);
    if (activityId.isErr()) {
      throw new Error("invalid activity id");
    }
    const inboxUrl = `${bob.actorUri}/inbox`;
    stubFetch({ [inboxUrl]: SERVER_ERROR });

    const outcome = await attemptInboxDelivery(env, {
      kind: "DeliverTarget",
      activityId: activityId.value,
      inboxUrl,
    });

    expect(outcome).toEqual({
      kind: "TransientFailure",
      cause: { kind: "HttpStatus", httpStatus: 500 },
    });
    expect(OutboxDelivery.afterAttempt(OutboxDelivery.queued(), outcome)).toEqual({
      kind: "Queued",
      attemptCount: 1,
    });
  });
});
