import { writeMetric } from "./metrics";

export const handleScheduled = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): void => {
  ctx.waitUntil(
    Promise.all([
      env.OUTBOX_PROCESS_QUEUE.send({ kind: "ProcessExpiredPolls" }),
      // Refresh the previews whose cache entry has aged out.
      env.OUTBOX_PROCESS_QUEUE.send({ kind: "RefreshLinkCards" }),
      // Index the tags of remote statuses written before the tag index.
      env.OUTBOX_PROCESS_QUEUE.send({ kind: "BackfillRemoteTags" }),
    ]).then(() => {
      writeMetric(env, "cron", [1], [controller.cron, "scheduled"]);
    }),
  );
};
