import { env } from "cloudflare:test";
import { DeadOutboxJob } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { handleDeadLetterQueue } from "./dead-letter-queue";
import { deadOutboxJobId } from "./dead-outbox-job-store";
import { processOutboxJob } from "./outbox-job";
import { handleQueue, MAX_JOB_ATTEMPTS } from "./queue-handler";

const OPTIONS = { outboxAttempts: 4, maxAttempts: 6 } as const;

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};
const QUEUED_BATCH: QueueSendBatchResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

type Decision = "ack" | "retry";

const batchOf = (bodies: ReadonlyArray<unknown>, attempts = 1) => {
  const decisions: Decision[] = [];
  return {
    decisions,
    batch: {
      messages: bodies.map((body) => ({
        body,
        attempts,
        ack: () => decisions.push("ack"),
        retry: () => decisions.push("retry"),
      })),
    },
  };
};

const DeadRow = z.object({
  id: z.string(),
  job_kind: z.string(),
  reason: z.string(),
  body_json: z.string(),
  attempts: z.number(),
  dead_count: z.number(),
  error: z.string().nullable(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

const deadRow = async (body: unknown) => {
  const row = await env.DB.prepare("SELECT * FROM outbox_dead_jobs WHERE id = ?")
    .bind(await deadOutboxJobId(body))
    .first();
  return row === null ? undefined : DeadRow.parse(row);
};

const logged = (spy: ReturnType<typeof vi.spyOn>, kind: string): unknown[] =>
  spy.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((line: unknown): line is string => typeof line === "string")
    .map((line: string): unknown => JSON.parse(line))
    .filter(
      (event: unknown) =>
        typeof event === "object" && event !== null && Reflect.get(event, "kind") === kind,
    );

/** An `env` whose D1 refuses every statement. */
const brokenDb = () =>
  new Proxy(env, {
    get: (target, key) =>
      key === "DB"
        ? {
            prepare: () => {
              throw new Error("D1 down");
            },
            batch: async () => {
              throw new Error("D1 down");
            },
          }
        : Reflect.get(target, key),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the outbox dead-letter queue consumer", () => {
  it("stores a job the handler gave up on, with why, and logs it", async () => {
    const errors = vi.spyOn(console, "error");
    const job = { kind: "RefreshQuote", quoteId: "dlq-envelope" };
    const { batch, decisions } = batchOf([DeadOutboxJob.envelope(job, 3)]);
    await handleDeadLetterQueue(batch, env, OPTIONS);
    expect(decisions).toEqual(["ack"]);
    const row = await deadRow(job);
    expect(row).toMatchObject({
      job_kind: "RefreshQuote",
      reason: "RetriesExhausted",
      attempts: 3,
      dead_count: 1,
      error: "returned retry on each of 3 attempts",
    });
    expect(JSON.parse(row?.body_json ?? "")).toEqual(job);
    expect(row?.first_seen_at).toBe(row?.last_seen_at);
    expect(logged(errors, "OutboxJobDeadLettered")).toEqual([
      expect.objectContaining({
        id: row?.id,
        jobKind: "RefreshQuote",
        reason: "RetriesExhausted",
        attempts: 3,
      }),
    ]);
  });

  it("stores what Queues moved itself: a valid job as a handler failure, junk as unparseable", async () => {
    const valid = { kind: "RefreshQuote", quoteId: "dlq-raw" };
    const junk = { kind: "NoSuchJob", quoteId: "dlq-junk" };
    const { batch, decisions } = batchOf([valid, junk]);
    await handleDeadLetterQueue(batch, env, OPTIONS);
    expect(decisions).toEqual(["ack", "ack"]);
    expect(await deadRow(valid)).toMatchObject({ reason: "HandlerFailed", attempts: 4 });
    const stored = await deadRow(junk);
    expect(stored).toMatchObject({ job_kind: "NoSuchJob", reason: "Unparseable", attempts: 4 });
    expect(stored?.error).toMatch(/^not an OutboxJob: /);
  });

  it("counts the same job dead again on its row", async () => {
    const job = { kind: "RefreshQuote", quoteId: "dlq-twice" };
    await handleDeadLetterQueue(batchOf([DeadOutboxJob.envelope(job, 3)]).batch, env, OPTIONS);
    const first = await deadRow(job);
    await handleDeadLetterQueue(batchOf([job]).batch, env, OPTIONS);
    const second = await deadRow(job);
    expect(second).toMatchObject({ dead_count: 2, reason: "HandlerFailed", attempts: 4 });
    expect(second?.first_seen_at).toBe(first?.first_seen_at);
    expect((second?.last_seen_at ?? "") >= (first?.last_seen_at ?? "")).toBe(true);
  });

  it("retries a message it cannot store, and logs the body on the last attempt", async () => {
    const errors = vi.spyOn(console, "error");
    const job = { kind: "RefreshQuote", quoteId: "dlq-lost" };
    const early = batchOf([job], 1);
    await handleDeadLetterQueue(early.batch, brokenDb(), OPTIONS);
    expect(early.decisions).toEqual(["retry"]);
    expect(logged(errors, "OutboxDeadJobRecordFailed")).toHaveLength(1);
    expect(logged(errors, "OutboxDeadJobLost")).toEqual([]);

    const last = batchOf([job], OPTIONS.maxAttempts);
    await handleDeadLetterQueue(last.batch, brokenDb(), OPTIONS);
    expect(last.decisions).toEqual(["retry"]);
    expect(logged(errors, "OutboxDeadJobLost")).toEqual([
      expect.objectContaining({ jobKind: "RefreshQuote", body: job }),
    ]);
    expect(await deadRow(job)).toBeUndefined();
  });
});

describe("the outbox queue handler with a dead-letter queue", () => {
  // A job that returns retry while D1 is down.
  const failing = { kind: "VacuumMediaAttachments" } as const;

  it("retries a job that returns retry, then sends it to the dead-letter queue and acks it", async () => {
    const dead = vi.spyOn(env.OUTBOX_DLQ, "send").mockResolvedValue(QUEUED);
    const errors = vi.spyOn(console, "error");
    const early = batchOf([failing], MAX_JOB_ATTEMPTS - 1);
    await handleQueue(early.batch, brokenDb());
    expect(early.decisions).toEqual(["retry"]);
    expect(dead).not.toHaveBeenCalled();

    const last = batchOf([failing], MAX_JOB_ATTEMPTS);
    await handleQueue(last.batch, brokenDb());
    expect(last.decisions).toEqual(["ack"]);
    expect(dead).toHaveBeenCalledWith(DeadOutboxJob.envelope(failing, MAX_JOB_ATTEMPTS));
    expect(logged(errors, "OutboxJobExhausted")).toEqual([
      expect.objectContaining({ jobKind: "VacuumMediaAttachments", attempts: MAX_JOB_ATTEMPTS }),
    ]);
  });

  it("leaves the job to Queues when the dead-letter queue refuses it", async () => {
    vi.spyOn(env.OUTBOX_DLQ, "send").mockRejectedValue(new Error("dlq down"));
    const errors = vi.spyOn(console, "error");
    const last = batchOf([failing], MAX_JOB_ATTEMPTS);
    await handleQueue(last.batch, brokenDb());
    expect(last.decisions).toEqual(["retry"]);
    expect(logged(errors, "OutboxDeadLetterSendFailed")).toHaveLength(1);
  });

  it("retries a body that is not a job, for Queues to dead-letter after max_retries", async () => {
    const dead = vi.spyOn(env.OUTBOX_DLQ, "send");
    const { batch, decisions } = batchOf([{ kind: "NoSuchJob" }], 4);
    await handleQueue(batch, env);
    expect(decisions).toEqual(["retry"]);
    expect(dead).not.toHaveBeenCalled();
  });
});

describe("RequeueDeadOutboxJobs", () => {
  const store = async (bodies: ReadonlyArray<unknown>) =>
    handleDeadLetterQueue(batchOf(bodies).batch, env, OPTIONS);

  it("sends the selected jobs back as queued and deletes their rows", async () => {
    const polls = { kind: "RefreshQuote", quoteId: "requeue-kind-a" };
    const other = { kind: "DeliverPush", accountId: "1", notificationId: "2", subscriptionId: 3 };
    await store([DeadOutboxJob.envelope(polls, 3), other]);
    const sendBatch = vi
      .spyOn(env.OUTBOX_PROCESS_QUEUE, "sendBatch")
      .mockResolvedValue(QUEUED_BATCH);
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    const outcome = await processOutboxJob(env, {
      kind: "RequeueDeadOutboxJobs",
      select: { kind: "Ids", ids: [await deadOutboxJobId(polls)] },
      before: "",
    });
    expect(outcome).toBe("ok");
    expect(sendBatch).toHaveBeenCalledWith([{ body: polls }]);
    expect(send).not.toHaveBeenCalled();
    expect(await deadRow(polls)).toBeUndefined();
    expect(await deadRow(other)).toBeDefined();
  });

  it("pages through a large selection and leaves jobs that died after it started", async () => {
    const jobKind = "RequeuePageTest";
    const marker = "requeue-page";
    const bodies = Array.from({ length: DeadOutboxJob.requeuePage + 3 }, (_, index) => ({
      kind: jobKind,
      quoteId: `${marker}-${index}`,
    }));
    await store(bodies);
    const sent: unknown[] = [];
    vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "sendBatch").mockImplementation(async (messages) => {
      for (const message of messages) {
        sent.push(message.body);
      }
      return QUEUED_BATCH;
    });
    const chained: unknown[] = [];
    vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockImplementation(async (body) => {
      chained.push(body);
      return QUEUED;
    });
    const select = { kind: "JobKind", jobKind } as const;
    expect(await processOutboxJob(env, { kind: "RequeueDeadOutboxJobs", select, before: "" })).toBe(
      "ok",
    );
    expect(sent).toHaveLength(DeadOutboxJob.requeuePage);
    expect(chained).toEqual([
      { kind: "RequeueDeadOutboxJobs", select, before: expect.any(String) },
    ]);
    const next = z
      .object({ kind: z.literal("RequeueDeadOutboxJobs"), before: z.string() })
      .parse(chained[0]);

    // A job that dies again after the first page is not sent round again in this run.
    const late = { kind: jobKind, quoteId: `${marker}-late` };
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store([late]);
    expect(
      await processOutboxJob(env, { kind: "RequeueDeadOutboxJobs", select, before: next.before }),
    ).toBe("ok");
    const requeued = sent.filter(
      (body) =>
        typeof body === "object" &&
        body !== null &&
        String(Reflect.get(body, "quoteId")).startsWith(marker),
    );
    expect(requeued).toHaveLength(bodies.length);
    expect(await deadRow(late)).toBeDefined();
    expect(chained).toHaveLength(1);
  });
});
