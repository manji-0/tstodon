import { DeadOutboxJob, OutboxJob } from "@tstodon/domain";
import { failCsvImport } from "./csv-import-store";
import { processOutboxJob } from "./outbox-job";
import { writeMetric } from "./metrics";

/**
 * A job that returns retry runs this many times, then goes to the
 * dead-letter queue. It is fewer than the queue's `max_retries` + 1, so the
 * handler, not Queues, decides about a job that returns retry and can say so
 * in the message it dead-letters; Queues' own dead-lettering is left for
 * what the handler cannot decide (it threw, or the invocation failed).
 */
export const MAX_JOB_ATTEMPTS = 3;

/** The part of a queue batch the handler uses: Workers' `MessageBatch` and Void's `QueueBatch` both fit. */
export type OutboxBatch = Readonly<{
  messages: ReadonlyArray<
    Readonly<{
      body: unknown;
      attempts: number;
      ack: () => void;
      retry: () => void;
    }>
  >;
}>;

export const handleQueue = async (batch: OutboxBatch, env: Env): Promise<void> => {
  for (const message of batch.messages) {
    const parsed = OutboxJob.parse(message.body);
    if (parsed.isErr()) {
      console.error(
        JSON.stringify({
          kind: "OutboxJobRejected",
          issues: parsed.error.issues,
        }),
      );
      message.retry();
      continue;
    }
    const outcome = await processOutboxJob(env, parsed.value);
    if (outcome === "retry" && message.attempts < MAX_JOB_ATTEMPTS) {
      writeMetric(env, "outbox.job", [1], [parsed.value.kind, "retry"]);
      message.retry();
      continue;
    }
    if (outcome === "retry") {
      writeMetric(env, "outbox.job", [1], [parsed.value.kind, "failed"]);
      try {
        // The body as queued, so a requeue sends back exactly this message.
        await env.OUTBOX_DLQ.send(DeadOutboxJob.envelope(message.body, message.attempts));
      } catch (error) {
        // Not stored anywhere yet: leave it to Queues, which dead-letters it
        // itself once `max_retries` is reached.
        console.error(
          JSON.stringify({
            kind: "OutboxDeadLetterSendFailed",
            jobKind: parsed.value.kind,
            attempts: message.attempts,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        message.retry();
        continue;
      }
      console.error(
        JSON.stringify({
          kind: "OutboxJobExhausted",
          jobKind: parsed.value.kind,
          attempts: message.attempts,
        }),
      );
      if (parsed.value.kind === "ProcessCsvImport") {
        // Nothing will run the rest of the import unless it is requeued;
        // show it as stopped, not as running.
        await failCsvImport(env.DB, parsed.value.importId);
      }
    }
    message.ack();
  }
};
