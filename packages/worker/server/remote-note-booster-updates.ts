import { type OutboxJob, StatusTarget } from "@tstodon/domain";
import { err, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { measureJobPage } from "./metrics";
import { notifyFromRemoteOnce } from "./notify";
import { queueOutboxJobs } from "./queue-jobs";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { listLocalBoosterAccountIdsPage } from "./status-interaction-store";

/** Boosters one page lists, each given its own `Booster` job. */
export const BOOSTER_PAGE_SIZE = 50;

type BoostersJob = Extract<OutboxJob, { kind: "NotifyRemoteNoteBoosters" }>;
type Edit = Omit<BoostersJob, "kind" | "step">;

/**
 * Queue a `Booster` job for each of the next page of local accounts that
 * boost the edited note, and the next page when this one is full. Each
 * account is on one page only, as pages follow account ids.
 */
const queueBoosterPage = async (
  env: Env,
  edit: Edit,
  afterAccountId: string,
): Promise<Result<number, RepositoryError>> => {
  const boosters = await listLocalBoosterAccountIdsPage(
    env.DB,
    StatusTarget.remote(edit.statusId),
    afterAccountId,
    BOOSTER_PAGE_SIZE,
  );
  if (boosters.isErr()) {
    return err(boosters.error);
  }
  const last = boosters.value.at(-1);
  const jobs: BoostersJob[] = [
    ...boosters.value.map((accountId): BoostersJob => ({
      kind: "NotifyRemoteNoteBoosters",
      ...edit,
      step: { kind: "Booster", accountId },
    })),
    ...(boosters.value.length === BOOSTER_PAGE_SIZE && last !== undefined
      ? [
          {
            kind: "NotifyRemoteNoteBoosters",
            ...edit,
            step: { kind: "Page", afterAccountId: last },
          } satisfies BoostersJob,
        ]
      : []),
  ];
  const queued = await queueOutboxJobs(env, jobs);
  return queued.map(() => boosters.value.length);
};

/**
 * As Mastodon's `UpdateStatusService`, the local accounts that boosted an
 * edited remote note hear it changed; an inbox `Update` starts this with the
 * first page. Quotes are skipped: a local account cannot yet quote a remote
 * status. A notification is stored once per account since the edit
 * (`notifyFromRemoteOnce`), so a redelivered `Update` or a retried page that
 * queues an account again notifies it once.
 */
export const notifyRemoteNoteBoosters = async (
  env: Env,
  edit: Edit,
): Promise<Result<void, RepositoryError>> =>
  (await queueBoosterPage(env, edit, "")).map(() => undefined);

/** `NotifyRemoteNoteBoosters`: a page of boosters, or one booster. A note that is gone notifies nobody. */
export const processNotifyRemoteNoteBoostersJob = async (
  env: Env,
  job: BoostersJob,
): Promise<"ok" | "retry"> => {
  const { step } = job;
  const edit: Edit = { statusId: job.statusId, actorUri: job.actorUri, since: job.since };
  if (step.kind === "Page") {
    return measureJobPage(env, job.kind, async () => {
      const page = await queueBoosterPage(env, edit, step.afterAccountId);
      return page.isOk()
        ? { outcome: "ok", size: page.value, chained: page.value === BOOSTER_PAGE_SIZE }
        : { outcome: "retry", size: -1, chained: false };
    });
  }
  const found = await findRemoteStatusesByIds(env.DB, [job.statusId]);
  if (found.isErr()) {
    return "retry";
  }
  if (!found.value.has(job.statusId)) {
    return "ok";
  }
  const sent = await notifyFromRemoteOnce(
    env,
    { accountId: step.accountId, actorUri: job.actorUri, kind: "update", statusId: job.statusId },
    job.since,
  );
  return sent.isOk() ? "ok" : "retry";
};
