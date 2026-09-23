import { writeMetric } from "./metrics";

export const handleScheduled = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void => {
  ctx.waitUntil(
    env.OUTBOX_PROCESS_QUEUE.send({
      kind: "ProcessExpiredPolls",
    }).then(() => {
      writeMetric(env, "cron", [1], [controller.cron, "scheduled"]);
    }),
  );
};
