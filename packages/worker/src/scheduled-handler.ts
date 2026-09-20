export const handleScheduled = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void => {
  ctx.waitUntil(
    env.OUTBOX_PROCESS_QUEUE.send({
      kind: "ProcessExpiredPolls",
    }).then(() => {
      env.METRICS.writeDataPoint({
        blobs: [controller.cron, "scheduled"],
        doubles: [1],
        indexes: ["cron"],
      });
    }),
  );
};
