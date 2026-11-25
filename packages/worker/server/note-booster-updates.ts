import {
  type OutboxJob,
  type StatusIdValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { measureJobPage } from "./metrics";
import { notifyAccountOnce, notifyFromRemoteOnce } from "./notify";
import { deleteNotificationsBefore } from "./notification-store";
import { listAcceptedQuoteEdges } from "./quote-store";
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
 * A status that changed at `since`, with its author: a local account, or
 * the remote actor whose activity changed it.
 */
export type StatusChange = Readonly<
  | { kind: "RemoteStatus"; statusId: StatusIdValue; actorUri: string; since: string }
  | { kind: "LocalStatus"; statusId: StatusIdValue; accountId: string; since: string }
>;

/** Queue the first page of the local accounts that boost the changed status. */
const notifyNoteBoosters = async (
  env: Env,
  change: StatusChange,
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
 * Tell the local accounts that boosted a changed status, or quote it in an
 * accepted quote, that it changed, as Mastodon's
 * `FanOutOnWriteService#notify_about_update!`: `update` to the boosters
 * (queued, a job per booster) and `quoted_update` to the quoters, about
 * their own quoting status. Mastodon runs it whenever `DistributionWorker`
 * distributes a status as an update without `skip_notifications`, local or
 * remote: an edit, the quoted author's `Accept` of the status's quote, and a
 * quote's revoke or new state after a check (`RevokeQuoteService`,
 * `Delete#revoke_quote`, `RefetchAndVerifyQuoteWorker`). Each account keeps
 * the latest such notification only, as `LocalNotificationWorker` deletes
 * the older ones, and a retried change notifies it once. The author is not
 * told of its own status (`deliverNotification`, `from_self?`).
 */
export const notifyAboutUpdate = async (
  env: Env,
  change: StatusChange,
): Promise<Result<void, RepositoryError>> => {
  const boosters = await notifyNoteBoosters(env, change);
  if (boosters.isErr()) {
    return boosters;
  }
  const edges = await listAcceptedQuoteEdges(
    env.DB,
    change.kind === "LocalStatus"
      ? StatusTarget.local(change.statusId)
      : StatusTarget.remote(change.statusId),
  );
  // Best effort: the change is stored, and a quoter's notification that
  // cannot be read or written is no reason to fail it.
  for (const edge of edges.isOk() ? edges.value : []) {
    const notification = {
      accountId: edge.accountId,
      kind: "quoted_update",
      statusId: edge.statusId,
    } as const;
    const cleared = await deleteNotificationsBefore(env.DB, {
      ...notification,
      before: change.since,
    });
    if (cleared.isErr()) {
      continue;
    }
    await (change.kind === "LocalStatus"
      ? notifyAccountOnce(env, { ...notification, fromAccountId: change.accountId }, change.since)
      : notifyFromRemoteOnce(env, { ...notification, actorUri: change.actorUri }, change.since));
  }
  return ok(undefined);
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
