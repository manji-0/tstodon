import { writeMetric } from "./metrics";
import { refreshStaleRemoteActors } from "./remote-actor-refresh";

/**
 * The hourly entry of `app/crons/outbox-maintenance.ts`, whose `cron` export
 * must stay a literal for Void to read and is checked against this type. The
 * six-hourly entry fires at the same minute.
 */
export const HOURLY_CRON = "17 * * * *";

export const handleScheduled = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  // Returned as well as handed to `waitUntil`: a cron invocation waits for the
  // returned promise (up to 15 minutes), while `waitUntil` alone may be cut off
  // 30 s after the handler returns, before the actor refresh finishes.
  const work = Promise.all([
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "ProcessExpiredPolls" }),
    // Refresh the previews whose cache entry has aged out.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "RefreshLinkCards" }),
    // Index the tags of remote statuses written before the tag index.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "BackfillRemoteTags" }),
    // Move attachments stored at an id-derived key to a random one.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "RekeyLegacyMedia", afterId: "" }),
    // Publish the scheduled posts whose time has come.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "PublishScheduledStatuses" }),
    // Delete the old posts of accounts with automated post deletion on.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "CleanUpStatuses" }),
    // Re-fetch actors cached over a day ago, under the handle WebFinger
    // confirms; once an hour, not again when the six-hourly cron fires too.
    controller.cron === HOURLY_CRON ? refreshStaleRemoteActors(env) : undefined,
  ]).then(() => {
    writeMetric(env, "cron", [1], [controller.cron, "scheduled"]);
  });
  ctx.waitUntil(work);
  return work;
};
