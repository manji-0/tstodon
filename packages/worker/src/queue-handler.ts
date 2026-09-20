import { OutboxJob } from "@tstodon/domain";

export const handleQueue = async (
  batch: MessageBatch<unknown>,
  _env: Env,
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
    console.log(JSON.stringify({ kind: "OutboxJobAccepted", job: parsed.value }));
    message.ack();
  }
  ctx.waitUntil(Promise.resolve());
};
