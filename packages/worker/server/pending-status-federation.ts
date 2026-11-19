import {
  type InstanceIdentity,
  type OwedStatusActivity,
  PendingStatusFederation,
  type PendingStatusFederation as PendingStatusFederationValue,
} from "@tstodon/domain";
import { findAccountById } from "./account-store";
import { nowInstant, nowIso } from "./clock";
import { noteCreateActivity } from "./local-note-document";
import { noteUpdateActivity, readNoteObject, requestQuoteApproval } from "./local-note-object";
import { measureJobPage, writeMetric } from "./metrics";
import {
  deferStatusFederation,
  dropStatusFederation,
  hasDueStatusFederation,
  listDueStatusFederations,
  postponeStatusFederation,
  reviseStatusFederation,
  storeOwedActivity,
} from "./pending-status-federation-store";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";

/** Owed activities one job run tries. */
const PAGE = 20;

const later = (delaySeconds: number): string =>
  new Date(Date.now() + delaySeconds * 1000).toISOString();

/**
 * Queue the job that tries the owed activities `delaySeconds` from now. A
 * failed send is logged and left to the hourly cron, which queues the job
 * while any is due.
 */
const queueRetry = async (env: Env, statusId: string, delaySeconds: number): Promise<void> => {
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({ kind: "FederatePendingStatuses" }, { delaySeconds });
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "StatusFederationRetryNotQueued",
        statusId,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
};

/**
 * Record that a just-stored or just-edited status owes `activity`, which
 * could not be built (FED-14), and queue its retry, as Mastodon's Sidekiq
 * retries a distribution worker that raised. A failure to record it is
 * logged: the status then stays local, as before the retries existed.
 */
export const deferStatusActivity = async (
  env: Env,
  statusId: string,
  activity: OwedStatusActivity,
): Promise<void> => {
  const retry = PendingStatusFederation.afterFailure(1);
  const delaySeconds = retry.kind === "Retry" ? retry.delaySeconds : 0;
  const deferred = await deferStatusFederation(env.DB, statusId, activity, later(delaySeconds));
  if (deferred.isErr()) {
    console.error(
      JSON.stringify({
        kind: "StatusFederationNotDeferred",
        statusId,
        activity,
        message: deferred.error.message,
      }),
    );
    return;
  }
  await queueRetry(env, statusId, delaySeconds);
};

/**
 * For an edit of a status: when the status still owes an activity, that
 * activity is sent with the edited version, as soon as the queue runs it,
 * and the edit sends no `Update` of its own (the receivers of a `Create`
 * not sent yet have nothing to update). Resolves to whether it owes one; a
 * failed read counts as none.
 */
export const deferToOwedActivity = async (env: Env, statusId: string): Promise<boolean> => {
  const revised = await reviseStatusFederation(env.DB, statusId);
  if (revised.isErr() || !revised.value) {
    return false;
  }
  await queueRetry(env, statusId, 0);
  return true;
};

/** Whether an owed activity is due (the hourly cron's check). */
export const hasDueStatusFederations = async (env: Env): Promise<boolean> =>
  (await hasDueStatusFederation(env.DB, nowIso())).unwrapOr(false);

/** Count a failed try; after the last one, give the activity up and say so. */
const failed = async (
  env: Env,
  pending: PendingStatusFederationValue,
  cause: string,
): Promise<void> => {
  const attempts = pending.attempts + 1;
  const next = PendingStatusFederation.afterFailure(attempts);
  if (next.kind === "GiveUp") {
    await dropStatusFederation(env.DB, pending.statusId);
    console.error(
      JSON.stringify({
        kind: "StatusFederationAbandoned",
        statusId: pending.statusId,
        activity: pending.activity,
        attempts,
        cause,
      }),
    );
    return;
  }
  const postponed = await postponeStatusFederation(
    env.DB,
    pending,
    attempts,
    later(next.delaySeconds),
  );
  if (postponed.isOk()) {
    await queueRetry(env, pending.statusId, next.delaySeconds);
  }
};

/**
 * Build the owed activity from the status as it is now and send it, once:
 * an edit made meanwhile goes in it (a `Create` carries the current
 * version), a deleted status takes its row with it, and a status changed
 * while this ran is left to the retry its change queued.
 */
const federate = async (
  env: Env,
  identity: InstanceIdentity,
  pending: PendingStatusFederationValue,
): Promise<void> => {
  const status = await findStatusById(env.DB, pending.statusId);
  if (status.isErr()) {
    return failed(env, pending, "status");
  }
  if (status.value?.kind !== "LocalNote") {
    await dropStatusFederation(env.DB, pending.statusId);
    return;
  }
  const account = await findAccountById(env.DB, status.value.accountId);
  if (account.isErr()) {
    return failed(env, pending, "account");
  }
  if (!account.value) {
    await dropStatusFederation(env.DB, pending.statusId);
    return;
  }
  const now = nowInstant();
  // An `Update` is stamped with this change, as an edit's own is, so a
  // receiver takes it as newer than its copy.
  const note = pending.activity === "Update" ? { ...status.value, editedAt: now } : status.value;
  const read = await readNoteObject(env, identity, account.value, note);
  if (read.isErr()) {
    return failed(env, pending, read.error.cause);
  }
  const payload =
    pending.activity === "Create"
      ? noteCreateActivity(identity, account.value, read.value.object)
      : noteUpdateActivity(identity, account.value, note, read.value.object, now);
  const stored = await storeOwedActivity(env.DB, pending, account.value.id, payload);
  if (stored.isErr()) {
    return failed(env, pending, "store");
  }
  if (stored.value === undefined) {
    return;
  }
  console.log(
    JSON.stringify({
      kind: "StatusFederated",
      statusId: pending.statusId,
      activity: pending.activity,
      attempts: pending.attempts + 1,
    }),
  );
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({ kind: "ExpandFollowers", activityId: stored.value });
    writeMetric(env, "outbox.enqueue", [1], [pending.activity, "retried"]);
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueQueueSendFailed",
        accountId: account.value.id,
        activityId: stored.value,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
  if (pending.activity === "Create") {
    await requestQuoteApproval(env, identity, account.value, note, read.value);
  }
};

/**
 * The `FederatePendingStatuses` job: try each owed activity that is due, a
 * page at a time, the longest waiting first.
 */
export const processFederatePendingStatusesJob = (env: Env): Promise<"ok" | "retry"> =>
  measureJobPage(env, "FederatePendingStatuses", async () => {
    const identity = parseInstanceIdentity(env);
    const due = identity.isOk()
      ? await listDueStatusFederations(env.DB, nowIso(), PAGE)
      : undefined;
    if (identity.isErr() || due === undefined || due.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    for (const pending of due.value) {
      await federate(env, identity.value, pending);
    }
    const chained = due.value.length === PAGE;
    if (chained) {
      await env.OUTBOX_PROCESS_QUEUE.send({ kind: "FederatePendingStatuses" });
    }
    return { outcome: "ok", size: due.value.length, chained };
  });
