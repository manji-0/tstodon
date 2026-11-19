import type { OutboxJob } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type RepositoryError, toRepositoryError } from "./d1";

/** Workers Queues takes at most 100 messages in one `sendBatch`. */
const SEND_BATCH_LIMIT = 100;

/**
 * Send `jobs` to the outbox queue, 100 a batch. An error when a batch could
 * not be sent; the batches before it were.
 */
export const queueOutboxJobs = async (
  env: Env,
  jobs: ReadonlyArray<OutboxJob>,
): Promise<Result<void, RepositoryError>> => {
  for (let start = 0; start < jobs.length; start += SEND_BATCH_LIMIT) {
    try {
      await env.OUTBOX_PROCESS_QUEUE.sendBatch(
        jobs.slice(start, start + SEND_BATCH_LIMIT).map((body) => ({ body })),
      );
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
