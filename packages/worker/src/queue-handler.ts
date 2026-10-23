import { OutboxJob } from "@tstodon/domain";
import { processOutboxJob } from "./outbox-job";
import { writeMetric } from "./metrics";

/** Transient job failures are retried a few times before being dropped. */
const MAX_JOB_ATTEMPTS = 3;

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
    }
    message.ack();
  }
};
