import { OutboxJob } from "@tstodon/domain";
import { processOutboxJob } from "./delivery";
import { writeMetric } from "./metrics";

/** Transient job failures are retried a few times before being dropped. */
const MAX_JOB_ATTEMPTS = 3;

export const handleQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
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
  ctx.waitUntil(Promise.resolve());
};
