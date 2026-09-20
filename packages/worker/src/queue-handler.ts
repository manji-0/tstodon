import { OutboxJob } from "@tstodon/domain";
import { processOutboxJob } from "./delivery";

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
    await processOutboxJob(env, parsed.value);
    message.ack();
  }
  ctx.waitUntil(Promise.resolve());
};
