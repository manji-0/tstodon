import type { OutboxJob } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type RepositoryError, toRepositoryError } from "./d1";

/** Workers Queues takes at most 100 messages in one `sendBatch`. */
const SEND_BATCH_LIMIT = 100;
/** And at most 256 KB of them; the rest is left for each message's overhead. */
const SEND_BATCH_BYTES = 192 * 1024;

/** `jobs` in `sendBatch`-sized runs, by count and by size. */
const batches = (jobs: ReadonlyArray<OutboxJob>): ReadonlyArray<ReadonlyArray<OutboxJob>> => {
  const runs: OutboxJob[][] = [];
  let bytes = 0;
  for (const job of jobs) {
    const size = JSON.stringify(job).length;
    const last = runs.at(-1);
    if (last === undefined || last.length >= SEND_BATCH_LIMIT || bytes + size > SEND_BATCH_BYTES) {
      runs.push([job]);
      bytes = size;
    } else {
      last.push(job);
      bytes += size;
    }
  }
  return runs;
};

/**
 * Send `jobs` to `queue`, the outbox queue unless it names another, in runs
 * `sendBatch` takes. An error when a run could not be sent; the runs before
 * it were.
 */
export const queueOutboxJobs = async (
  env: Env,
  jobs: ReadonlyArray<OutboxJob>,
  queue: Queue = env.OUTBOX_PROCESS_QUEUE,
): Promise<Result<void, RepositoryError>> => {
  for (const run of batches(jobs)) {
    try {
      await queue.sendBatch(run.map((body) => ({ body })));
    } catch (cause) {
      return err(
        toRepositoryError(
          `queueing jobs failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }
  return ok(undefined);
};
