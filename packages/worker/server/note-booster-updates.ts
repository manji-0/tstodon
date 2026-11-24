import {
  type OutboxJob,
  type StatusIdValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { measureJobPage } from "./metrics";
import { notifyAccountOnce, notifyFromRemoteOnce } from "./notify";
import { deleteNotificationsBefore } from "./notification-store";
import { queueOutboxJobs } from "./queue-jobs";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { listLocalBoosterAccountIdsPage } from "./status-interaction-store";
import { findStatusById } from "./status-store";

/** Boosters one page lists, each given its own `Booster` job. */
export const BOOSTER_PAGE_SIZE = 50;

type RemoteJob = Extract<OutboxJob, { kind: "NotifyRemoteNoteBoosters" }>;
type LocalJob = Extract<OutboxJob, { kind: "NotifyLocalNoteBoosters" }>;
type BoostersJob = RemoteJob | LocalJob;
type Step = BoostersJob["step"];

/** The same job with another step. */
const withStep = (job: BoostersJob, step: Step): BoostersJob => ({ ...job, step });

const targetOf = (job: BoostersJob): StatusTargetValue =>
  job.kind === "NotifyRemoteNoteBoosters"
    ? StatusTarget.remote(job.statusId)
    : StatusTarget.local(job.statusId);

/**
 * Queue a `Booster` job for each of the next page of local accounts that
 * boost the note, and the next page when this one is full. Each account is
 * on one page only, as pages follow account ids.
 */
const queueBoosterPage = async (
  env: Env,
  job: BoostersJob,
  afterAccountId: string,
): Promise<Result<number, RepositoryError>> => {
  const boosters = await listLocalBoosterAccountIdsPage(
    env.DB,
    targetOf(job),
    afterAccountId,
    BOOSTER_PAGE_SIZE,
  );
  if (boosters.isErr()) {
    return err(boosters.error);
  }
  const last = boosters.value.at(-1);
  const jobs = [
    ...boosters.value.map((accountId) => withStep(job, { kind: "Booster", accountId })),
    ...(boosters.value.length === BOOSTER_PAGE_SIZE && last !== undefined
      ? [withStep(job, { kind: "Page", afterAccountId: last })]
      : []),
  ];
  const queued = await queueOutboxJobs(env, jobs);
  return queued.map(() => boosters.value.length);
};

/**
 * As Mastodon's `FanOutOnWriteService#notify_about_update!`, the local
 * accounts that boosted a changed note hear it changed (`update`). An inbox
 * `Update` that edits a remote note starts this, and for a local note its
 * edit and the quoted author's `Accept` of its quote do (`accept_quote!`
 * distributes the note as an update without `skip_notifications`). A
 * notification is stored once per account since the change, so a
 * redelivered activity or a retried page that queues an account again
 * notifies it once.
 */
export const notifyNoteBoosters = async (
  env: Env,
  change: Readonly<
    | { kind: "RemoteStatus"; statusId: StatusIdValue; actorUri: string; since: string }
    | { kind: "LocalStatus"; statusId: StatusIdValue; since: string }
  >,
): Promise<Result<void, RepositoryError>> => {
  const first = { kind: "Page", afterAccountId: "" } as const satisfies Step;
  const job: BoostersJob =
    change.kind === "RemoteStatus"
      ? {
          kind: "NotifyRemoteNoteBoosters",
          statusId: change.statusId,
          actorUri: change.actorUri,
          since: change.since,
          step: first,
        }
      : {
          kind: "NotifyLocalNoteBoosters",
          statusId: change.statusId,
          since: change.since,
          step: first,
        };
  return (await queueBoosterPage(env, job, "")).map(() => undefined);
};

/**
 * Notify one booster, from the note's author, unless the note is gone. As
 * Mastodon's `LocalNotificationWorker` does for `update`, the booster's
 * earlier `update` notifications about the note are deleted first, so it
 * holds the latest one only. The author's own boost notifies nobody, as
 * `NotifyService`'s `from_self?` drops it (`deliverNotification`).
 */
const notifyBooster = async (
  env: Env,
  job: BoostersJob,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const update = { accountId, kind: "update", statusId: job.statusId } as const;
  const notify =
    job.kind === "NotifyRemoteNoteBoosters"
      ? (await findRemoteStatusesByIds(env.DB, [job.statusId])).map((found) =>
          found.has(job.statusId)
            ? () => notifyFromRemoteOnce(env, { ...update, actorUri: job.actorUri }, job.since)
            : undefined,
        )
      : (await findStatusById(env.DB, job.statusId)).map((status) =>
          status
            ? () =>
                notifyAccountOnce(env, { ...update, fromAccountId: status.accountId }, job.since)
            : undefined,
        );
  if (notify.isErr() || notify.value === undefined) {
    return notify.map(() => undefined);
  }
  const cleared = await deleteNotificationsBefore(env.DB, { ...update, before: job.since });
  return cleared.isErr() ? cleared : notify.value();
};

/** `NotifyRemoteNoteBoosters` and `NotifyLocalNoteBoosters`: a page of boosters, or one booster. */
export const processNotifyNoteBoostersJob = async (
  env: Env,
  job: BoostersJob,
): Promise<"ok" | "retry"> => {
  const { step } = job;
  if (step.kind === "Page") {
    return measureJobPage(env, job.kind, async () => {
      const page = await queueBoosterPage(env, job, step.afterAccountId);
      return page.isOk()
        ? { outcome: "ok", size: page.value, chained: page.value === BOOSTER_PAGE_SIZE }
        : { outcome: "retry", size: -1, chained: false };
    });
  }
  const sent = await notifyBooster(env, job, step.accountId);
  return sent.isOk() ? "ok" : "retry";
};
