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
      // Move attachments stored at an id-derived key to a random one.
      env.OUTBOX_PROCESS_QUEUE.send({ kind: "RekeyLegacyMedia" }),
      // Publish the scheduled posts whose time has come.
      env.OUTBOX_PROCESS_QUEUE.send({ kind: "PublishScheduledStatuses" }),
      // Delete the old posts of accounts with automated post deletion on.
      env.OUTBOX_PROCESS_QUEUE.send({ kind: "CleanUpStatuses" }),
    ]).then(() => {
      writeMetric(env, "cron", [1], [controller.cron, "scheduled"]);
    }),
  );
};
