import { DeadOutboxJob, type OutboxJob as OutboxJobValue } from "@tstodon/domain";
import { ok } from "neverthrow";
import { nowIso } from "./clock";
import {
  deleteDeadOutboxJobs,
  listDeadOutboxJobs,
  recordDeadOutboxJob,
  recordDeadOutboxJobs,
} from "./dead-outbox-job-store";
import { measureJobPage, writeMetric } from "./metrics";
import type { OutboxBatch } from "./queue-handler";

type RequeueJob = Extract<OutboxJobValue, { kind: "RequeueDeadOutboxJobs" }>;

export type DeadLetterOptions = Readonly<{
  /** Deliveries on the outbox queue before Queues moves a message here (`max_retries` + 1). */
  outboxAttempts: number;
  /** Deliveries on this queue before Queues discards a message (`max_retries` + 1). */
  maxAttempts: number;
}>;

/**
 * The consumer of `tstodon-outbox-dlq`: store each dead outbox job in
 * `outbox_dead_jobs` (`OutboxJobDeadLettered`), where an operator reads it
 * and the `RequeueDeadOutboxJobs` job sends it back. A message that cannot
 * be stored is retried; on its last attempt its body goes to the log
 * (`OutboxDeadJobLost`), since nothing keeps it after that.
 */
export const handleDeadLetterQueue = async (
  batch: OutboxBatch,
  env: Env,
  options: DeadLetterOptions,
): Promise<void> => {
  const classified = batch.messages.map((message) => ({
    message,
    entry: DeadOutboxJob.classify(message.body, options.outboxAttempts),
  }));
  // One batch stores every message; if it fails, each message is stored on
  // its own, so one that cannot be stored does not send the others back.
  const stored = await recordDeadOutboxJobs(
    env.DB,
    classified.map(({ entry }) => entry),
    nowIso(),
  );
  for (const [index, { message, entry }] of classified.entries()) {
    const storedId = stored.isOk() ? stored.value[index] : undefined;
    const recorded =
      storedId === undefined ? await recordDeadOutboxJob(env.DB, entry, nowIso()) : ok(storedId);
    if (recorded.isErr()) {
      const lost = message.attempts >= options.maxAttempts;
      console.error(
        JSON.stringify({
          kind: lost ? "OutboxDeadJobLost" : "OutboxDeadJobRecordFailed",
          jobKind: entry.jobKind,
          attempts: message.attempts,
          message: recorded.error.message,
          ...(lost ? { body: entry.body } : {}),
        }),
      );
      message.retry();
      continue;
    }
    // doubles: [count, attemptsOnOutboxQueue]; blobs: [jobKind, reason]
    writeMetric(env, "outbox.dead", [1, entry.attempts], [entry.jobKind, entry.reason.kind]);
    console.error(
      JSON.stringify({
        kind: "OutboxJobDeadLettered",
        id: recorded.value,
        jobKind: entry.jobKind,
        reason: entry.reason.kind,
        attempts: entry.attempts,
        error: DeadOutboxJob.describe(entry),
      }),
    );
    message.ack();
  }
};

/**
 * One page of `RequeueDeadOutboxJobs`: send the next stored dead jobs back
 * to the outbox queue and delete their rows; a full page queues the next,
 * with the first page's time as `before`.
 */
export const requeueDeadOutboxJobs = (env: Env, job: RequeueJob): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, async () => {
    const before = job.before === "" ? nowIso() : job.before;
    const page = await DeadOutboxJob.requeue(
      {
        list: (select, seenBefore, limit) => listDeadOutboxJobs(env.DB, select, seenBefore, limit),
        send: async (bodies) => {
          await env.OUTBOX_PROCESS_QUEUE.sendBatch(bodies.map((body) => ({ body })));
        },
        remove: (ids) => deleteDeadOutboxJobs(env.DB, ids),
      },
      job.select,
      before,
    );
    if (page.isErr()) {
      return { outcome: "retry", size: 0, chained: false, step: job.select.kind };
    }
    const { requeued, chained } = page.value;
    if (chained) {
      await env.OUTBOX_PROCESS_QUEUE.send({ kind: job.kind, select: job.select, before });
    }
    console.log(
      JSON.stringify({
        kind: "OutboxDeadJobsRequeued",
        select: job.select.kind,
        requeued,
        chained,
      }),
    );
    return { outcome: "ok", size: requeued, chained, step: job.select.kind };
  });
