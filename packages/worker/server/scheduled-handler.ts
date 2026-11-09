import { writeMetric } from "./metrics";
import { refreshStaleRemoteActors } from "./remote-actor-refresh";
import { sweepStuckDeliveries } from "./stuck-delivery-sweep";

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
    // Store the tag names of local notes written before the tags table; a
    // single read once the cursor is complete.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "BackfillLocalNoteTags" }),
    // Move attachments stored at an id-derived key to a random one.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "RekeyLegacyMedia", afterId: "" }),
    // Publish the scheduled posts whose time has come.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "PublishScheduledStatuses" }),
    // Delete the old posts of accounts with automated post deletion on.
    env.OUTBOX_PROCESS_QUEUE.send({ kind: "CleanUpStatuses" }),
    // Delete media left unattached for over a day (Mastodon's daily
    // `MediaAttachmentsVacuum`); on the six-hourly cron only.
    controller.cron === HOURLY_CRON
      ? undefined
      : env.OUTBOX_PROCESS_QUEUE.send({ kind: "VacuumMediaAttachments" }),
    // Strip the metadata from media stored before stripping on upload; once
    // every row is marked, one page that reads nothing. Six-hourly only, so a
    // long first run is not joined by a second chain every hour.
    controller.cron === HOURLY_CRON
      ? undefined
      : env.OUTBOX_PROCESS_QUEUE.send({
          kind: "StripStoredMediaMetadata",
          source: "attachments",
          afterId: "",
        }),
    // Record the byte size of objects stored before sizes were recorded (a
    // HEAD each, no body read); once every size is known, one query that
    // reads nothing. Six-hourly only, as the metadata backfill.
    controller.cron === HOURLY_CRON
      ? undefined
      : env.OUTBOX_PROCESS_QUEUE.send({
          kind: "BackfillStoredMediaSizes",
          source: "attachments",
          afterId: "",
        }),
    // Re-fetch actors cached over a day ago, under the handle WebFinger
    // confirms; once an hour, not again when the six-hourly cron fires too.
    controller.cron === HOURLY_CRON ? refreshStaleRemoteActors(env) : undefined,
    // Start or restart the delivery Workflows of targets left `Queued` past
    // their next attempt (a failed create, a step that errored); hourly only.
    controller.cron === HOURLY_CRON ? sweepStuckDeliveries(env) : undefined,
  ]).then(() => {
    writeMetric(env, "cron", [1], [controller.cron, "scheduled"]);
  });
  ctx.waitUntil(work);
  return work;
};
