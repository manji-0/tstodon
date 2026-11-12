import { type OutboxJob, StoredMediaMetadata, StoredMediaSizes } from "@tstodon/domain";
import { releaseStaleInboxClaims } from "./inbox-store";
import { runOrQueue } from "./inline-job";
import { writeMetric } from "./metrics";
import { hasExpiredPollWork } from "./poll-expiry";
import { hasDueScheduledStatuses } from "./scheduled-status-publish";
import { processOutboxJob } from "./outbox-job";
import { refreshStaleRemoteActors } from "./remote-actor-refresh";
import { deleteAbandonedOwed } from "./remote-status-owed";
import { runRemoteStatusRetention } from "./remote-status-retention";
import { sweepStuckDeliveries } from "./stuck-delivery-sweep";

/**
 * The hourly entry of `app/crons/outbox-maintenance.ts`, whose `cron` export
 * must stay a literal for Void to read and is checked against this type. The
 * six-hourly entry fires at the same minute.
 */
export const HOURLY_CRON = "17 * * * *";

/**
 * Delete the inbox claims whose apply was cut off. A redelivery takes over a
 * stale claim itself; this clears the ones no sender retries, which the
 * activity vacuum leaves alone.
 */
const releaseStaleClaims = async (env: Env): Promise<void> => {
  const released = await releaseStaleInboxClaims(env.DB);
  if (released.isErr()) {
    console.error(
      JSON.stringify({ kind: "InboxStaleClaimsFailed", message: released.error.message }),
    );
  } else if (released.value > 0) {
    console.log(JSON.stringify({ kind: "InboxStaleClaims", released: released.value }));
  }
};

/**
 * Delete the markers of late work on a remote note that no redelivery
 * finished within the retention (`remote_status_owed`). The warning is the
 * record that this work stays undone.
 */
const sweepAbandonedOwed = async (env: Env): Promise<void> => {
  const abandoned = await deleteAbandonedOwed(env.DB);
  if (abandoned.isErr()) {
    console.error(
      JSON.stringify({ kind: "RemoteStatusOwedSweepFailed", message: abandoned.error.message }),
    );
  } else if (abandoned.value.created + abandoned.value.edited > 0) {
    console.warn(JSON.stringify({ kind: "RemoteStatusOwedAbandoned", ...abandoned.value }));
  }
};

/**
 * How the cron runs a job. `Inline` runs one page in the cron invocation, as
 * the queue would: a job that pages queues its next page, and one that fails
 * is queued for the queue's retries. `Queued` sends it to the queue, after
 * `due` (when given) finds something to do: for a page that can cost more
 * D1 queries or CPU time than the cron invocation can spare.
 */
export type CronJob =
  | Readonly<{ kind: "Inline"; job: OutboxJob }>
  | Readonly<{ kind: "Queued"; job: OutboxJob; due?: (env: Env) => Promise<boolean> }>;

/**
 * The hourly cron's jobs. The run shares its invocation's 1000 D1 queries
 * with the actor refresh (up to about 610), so the jobs run here are those
 * whose page costs a few dozen queries at most.
 */
export const HOURLY_JOBS: ReadonlyArray<CronJob> = [
  // Refresh the previews whose cache entry has aged out.
  { kind: "Inline", job: { kind: "RefreshLinkCards" } },
  // Index the tags of remote statuses left to the backfill (written before
  // the tag index, or sent back by migration 0136); one empty read once none
  // is left.
  { kind: "Inline", job: { kind: "BackfillRemoteTags" } },
  // Index the tags of local notes written before `local_status_tags`; a
  // single read once the cursor is complete.
  { kind: "Inline", job: { kind: "BackfillLocalNoteTags" } },
  // Rename the tag names stored before accents were folded; a single read
  // once the cursor is complete.
  { kind: "Inline", job: { kind: "FoldTagNames" } },
  // Move attachments stored at an id-derived key to a random one.
  { kind: "Inline", job: { kind: "RekeyLegacyMedia", afterId: "" } },
  // Queue one cleanup run per account with automated post deletion on.
  { kind: "Inline", job: { kind: "CleanUpStatuses" } },
  // A page tells up to 50 voters and announces up to 50 polls.
  { kind: "Queued", job: { kind: "ProcessExpiredPolls" }, due: hasExpiredPollWork },
  // Publish the scheduled posts whose time has come, up to 20 posts a page.
  { kind: "Queued", job: { kind: "PublishScheduledStatuses" }, due: hasDueScheduledStatuses },
];

/** The six-hourly cron's jobs, which have their invocation to themselves. */
export const SIX_HOURLY_JOBS: ReadonlyArray<CronJob> = [
  // Delete media left unattached for over a day (Mastodon's daily
  // `MediaAttachmentsVacuum`).
  { kind: "Inline", job: { kind: "VacuumMediaAttachments" } },
  // Prune finished deliveries, old outbound activities and the inbox's dedupe
  // rows past their retention (Mastodon's `Vacuum::*` jobs run daily); one
  // indexed query per table when nothing is due.
  { kind: "Inline", job: { kind: "VacuumActivities" } },
  // Record the byte size of objects stored before sizes were recorded (a HEAD
  // each, no body read); once every size is known, one query that reads
  // nothing.
  {
    kind: "Inline",
    job: {
      kind: "BackfillStoredMediaSizes",
      source: "attachments",
      afterId: "",
      tally: StoredMediaSizes.emptyTally,
    },
  },
  // Strip the metadata from media stored before stripping on upload; once
  // every row is marked, one page that reads nothing. A page rewrites images,
  // which can take a whole invocation's CPU time. Six-hourly, so a long first
  // run is not joined by a second chain every hour.
  {
    kind: "Queued",
    job: {
      kind: "StripStoredMediaMetadata",
      source: "attachments",
      afterId: "",
      tally: StoredMediaMetadata.emptyTally,
    },
  },
];

const runJobs = async (env: Env, jobs: ReadonlyArray<CronJob>): Promise<void> => {
  for (const cronJob of jobs) {
    switch (cronJob.kind) {
      case "Inline":
        await runOrQueue(env, cronJob.job, processOutboxJob);
        break;
      case "Queued":
        if (!cronJob.due || (await cronJob.due(env))) {
          await env.OUTBOX_PROCESS_QUEUE.send(cronJob.job);
        }
        break;
    }
  }
};

export const handleScheduled = (
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => {
  // Returned as well as handed to `waitUntil`: a cron invocation waits for the
  // returned promise (up to 15 minutes), while `waitUntil` alone may be cut off
  // 30 s after the handler returns, before the actor refresh finishes.
  // Both crons fire at the same minute, so at hours 0, 6, 12 and 18 the hourly
  // cron runs beside the six-hourly one: each job belongs to exactly one cron.
  const work = Promise.all(
    controller.cron === HOURLY_CRON
      ? [
          runJobs(env, HOURLY_JOBS),
          // Re-fetch actors cached over a day ago, under the handle WebFinger
          // confirms.
          refreshStaleRemoteActors(env),
          // Delete a slice of stale remote statuses nothing local needs.
          runRemoteStatusRetention(env),
          // Start or restart the delivery Workflows of targets left `Queued`
          // past their next attempt (a failed create, a step that errored).
          sweepStuckDeliveries(env),
          releaseStaleClaims(env),
        ]
      : [
          runJobs(env, SIX_HOURLY_JOBS),
          // Give up the late work of remote notes that no redelivery finished
          // within a week; one indexed delete.
          sweepAbandonedOwed(env),
        ],
  ).then(() => {
    writeMetric(env, "cron", [1], [controller.cron, "scheduled"]);
  });
  ctx.waitUntil(work);
  return work;
};
