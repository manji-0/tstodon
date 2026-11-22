import {
  type InstanceIdentity,
  type LocalAccount,
  LocalAccountModeration,
  type OwedStatusActivity,
  PendingStatusFederation,
  type PendingStatusFederation as PendingStatusFederationValue,
  type StatusIdValue,
  StatusTarget,
} from "@tstodon/domain";
import { findLocalAccountModeration } from "./account-moderation-store";
import { findAccountById } from "./account-store";
import { nowInstant, nowIso } from "./clock";
import {
  admittedInboxes,
  logSkippedTargets,
  partitionByDomainAvailability,
  startOutboxDeliveryWorkflow,
} from "./delivery";
import { synchronizesFollowers } from "./followers-synchronization";
import { noteCreateActivity, noteUpdateActivity } from "./activitypub";
import { newEntityId } from "./ids";
import { type NoteObject, noteQuoteRequest, readNoteObject } from "./local-note-object";
import { deliveredActivity } from "./own-activity-signature";
import { measureJobPage, writeMetric } from "./metrics";
import {
  deferStatusFederation,
  dropStatusFederation,
  hasDueStatusFederation,
  listDueStatusFederations,
  type OwedQuoteRequest,
  postponeStatusFederation,
  reviseStatusFederation,
  storeOwedActivity,
} from "./pending-status-federation-store";
import { findQuoteByQuoting } from "./quote-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";

/** Owed activities one job run tries. */
const PAGE = 20;

/** How long a run waits before it tries again a row whose own write failed. */
const WRITE_FAILED_DELAY_SECONDS = 60;

const later = (delaySeconds: number): string =>
  new Date(Date.now() + delaySeconds * 1000).toISOString();

/**
 * Queue the job that tries the owed activities `delaySeconds` from now. A
 * failed send is logged and left to the hourly cron, which queues the job
 * while any is due.
 */
const queueRetry = async (env: Env, delaySeconds: number): Promise<void> => {
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(
      { kind: "FederatePendingStatuses" },
      delaySeconds > 0 ? { delaySeconds } : undefined,
    );
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "StatusFederationRetryNotQueued",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
};

/**
 * Record that a just-stored or just-changed status owes `activity`, which
 * could not be built (FED-14), and queue its retry, as Mastodon's Sidekiq
 * retries a distribution worker that raised. `editedAt` is when the change
 * that owes an `Update` was made. A failure to record it is logged: the
 * status then stays local, as before the retries existed.
 */
export const deferStatusActivity = async (
  env: Env,
  statusId: string,
  activity: OwedStatusActivity,
  editedAt?: string,
): Promise<void> => {
  const retry = PendingStatusFederation.afterFailure(1);
  const delaySeconds = retry.kind === "Retry" ? retry.delaySeconds : 0;
  const deferred = await deferStatusFederation(
    env.DB,
    statusId,
    activity,
    editedAt,
    later(delaySeconds),
  );
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
  await queueRetry(env, delaySeconds);
};

/**
 * Whether a changed status owes an activity: `Owed` when it does (the owed
 * activity goes out with this version, as soon as the queue runs it),
 * `Unknown` when the write that tells failed.
 */
export type OwedActivityCheck = "Owed" | "None" | "Unknown";

/**
 * For a change of a status: a status that still owes an activity sends that
 * one with the changed version, and nothing of its own, since the receivers
 * of a `Create` not sent yet have nothing to update. `editedAt` is when an
 * edit was made, `undefined` for a change that is no edit.
 */
export const deferToOwedActivity = async (
  env: Env,
  statusId: string,
  editedAt: string | undefined,
): Promise<OwedActivityCheck> => {
  const revised = await reviseStatusFederation(env.DB, statusId, editedAt);
  if (revised.isErr()) {
    return "Unknown";
  }
  if (!revised.value) {
    return "None";
  }
  await queueRetry(env, 0);
  return "Owed";
};

/** Whether an owed activity is due (the hourly cron's check). */
export const hasDueStatusFederations = async (env: Env): Promise<boolean> =>
  (await hasDueStatusFederation(env.DB, nowIso())).unwrapOr(false);

/**
 * What one try of an owed activity leaves to do: nothing, another run after
 * `delaySeconds`, or another one soon, as its row could not be written.
 */
type TryOutcome =
  | Readonly<{ kind: "Settled" }>
  | Readonly<{ kind: "Again"; delaySeconds: number }>
  /** The row's own write failed: it is still due. */
  | Readonly<{ kind: "WriteFailed" }>;

const settled: TryOutcome = { kind: "Settled" };

/** Forget the owed activity; a write that fails is tried again later. */
const drop = async (env: Env, pending: PendingStatusFederationValue): Promise<TryOutcome> =>
  (await dropStatusFederation(env.DB, pending)).isOk() ? settled : { kind: "WriteFailed" };

/** Count a failed try; after the last one, give the activity up and say so. */
const failed = async (
  env: Env,
  pending: PendingStatusFederationValue,
  cause: string,
): Promise<TryOutcome> => {
  const attempts = pending.attempts + 1;
  const next = PendingStatusFederation.afterFailure(attempts);
  if (next.kind === "GiveUp") {
    const dropped = await drop(env, pending);
    if (dropped.kind === "Settled") {
      console.error(
        JSON.stringify({
          kind: "StatusFederationAbandoned",
          statusId: pending.statusId,
          activity: pending.activity,
          attempts,
          cause,
        }),
      );
    }
    return dropped;
  }
  const postponed = await postponeStatusFederation(
    env.DB,
    pending,
    attempts,
    later(next.delaySeconds),
  );
  return postponed.isOk()
    ? { kind: "Again", delaySeconds: next.delaySeconds }
    : { kind: "WriteFailed" };
};

/**
 * The `QuoteRequest` an owed `Create` takes with it: while its quote of a
 * remote status is pending, under the id the quote keeps, to the quoted
 * author's inbox when this server contacts it. `undefined` when there is
 * none to send; an error when what it needs could not be read.
 */
const owedQuoteRequest = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  statusId: StatusIdValue,
  federated: NoteObject,
): Promise<OwedQuoteRequest | undefined | "Unreadable"> => {
  const { quote } = federated;
  const authorUri = quote?.addressAuthor;
  if (quote === undefined || authorUri === undefined) {
    return undefined;
  }
  const row = await findQuoteByQuoting(env.DB, StatusTarget.local(statusId));
  if (row.isErr()) {
    return "Unreadable";
  }
  const requestUri = row.value?.activityUri;
  if (row.value?.state.kind !== "Pending" || requestUri === undefined) {
    return undefined;
  }
  const author = await findRemoteActorByUri(env.DB, authorUri);
  if (author.isErr()) {
    return "Unreadable";
  }
  if (!author.value) {
    return undefined;
  }
  const allowHosts = await federationAllowHosts(env);
  const admitted = await admittedInboxes(env, [author.value.inboxUri], allowHosts);
  if (admitted.length === 0) {
    return undefined;
  }
  const { deliver, skipped } = await partitionByDomainAvailability(env.DB, admitted);
  return {
    // Signed as the post path signs it (`enqueueTargetedActivity`).
    payload: await deliveredActivity(
      env,
      account,
      noteQuoteRequest(identity, account, { ...federated, quote }, requestUri),
      allowHosts,
    ),
    deliver,
    skipped,
  };
};

/**
 * Build the owed activity from the status as it is now and send it, once:
 * a change made meanwhile goes in it (a `Create` carries the current
 * version), a deleted status takes its row with it, a status changed while
 * this ran is left to the retry its change queued, and the activity of an
 * account that is gone, suspended or disabled is dropped. A `Create` stores
 * its `QuoteRequest` in the same batch.
 */
const federate = async (
  env: Env,
  identity: InstanceIdentity,
  pending: PendingStatusFederationValue,
): Promise<TryOutcome> => {
  const status = await findStatusById(env.DB, pending.statusId);
  if (status.isErr()) {
    return failed(env, pending, "status");
  }
  if (status.value?.kind !== "LocalNote") {
    return drop(env, pending);
  }
  const account = await findAccountById(env.DB, status.value.accountId);
  if (account.isErr()) {
    return failed(env, pending, "account");
  }
  if (!account.value) {
    return drop(env, pending);
  }
  // A suspended or disabled account federates nothing, as a scheduled post
  // of one is not published.
  const moderation = await findLocalAccountModeration(env.DB, account.value.id);
  if (moderation.isErr()) {
    return failed(env, pending, "account");
  }
  if (LocalAccountModeration.isBarred(moderation.value)) {
    return drop(env, pending);
  }
  // An `Update` owed for an edit carries the edit's time, so a receiver takes
  // it as newer than its copy. One owed for a change that is no edit (a quote
  // policy) keeps the note's own `updated`, so the receiver records no edit.
  const editedAt = pending.editedAt ?? nowInstant();
  const note =
    pending.activity === "Update" && pending.editedAt !== undefined
      ? { ...status.value, editedAt }
      : status.value;
  const read = await readNoteObject(env, identity, account.value, note, pending.activity);
  if (read.isErr()) {
    return failed(env, pending, read.error.cause);
  }
  const quoteRequest =
    pending.activity === "Create"
      ? await owedQuoteRequest(env, identity, account.value, note.id, read.value)
      : undefined;
  if (quoteRequest === "Unreadable") {
    return failed(env, pending, "quote");
  }
  // Built and signed as the post and edit paths do (`enqueueLocalActivity`).
  const payload = await deliveredActivity(
    env,
    account.value,
    pending.activity === "Create"
      ? noteCreateActivity(identity, account.value, read.value.object)
      : noteUpdateActivity(read.value.object, newEntityId(), editedAt),
  );
  const stored = await storeOwedActivity(
    env.DB,
    pending,
    account.value.id,
    payload,
    quoteRequest,
    await synchronizesFollowers(env.DB, account.value.id, note.visibility),
  );
  if (stored.isErr()) {
    return failed(env, pending, "store");
  }
  if (stored.value === undefined) {
    return settled;
  }
  console.log(
    JSON.stringify({
      kind: "StatusFederated",
      statusId: pending.statusId,
      activity: pending.activity,
      attempts: pending.attempts + 1,
    }),
  );
  // A crash before these leaves the fan-out `Queued`, as on the post path,
  // and the `QuoteRequest`'s target to the stuck-delivery sweep.
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({
      kind: "ExpandFollowers",
      activityId: stored.value.activityId,
    });
    writeMetric(env, "outbox.enqueue", [1], [pending.activity, "retried"]);
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueQueueSendFailed",
        accountId: account.value.id,
        activityId: stored.value.activityId,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
  const { quoteRequestId } = stored.value;
  if (quoteRequestId !== undefined && quoteRequest !== undefined) {
    logSkippedTargets(env, quoteRequestId, quoteRequest.skipped, "targeted");
    if (quoteRequest.deliver.length > 0) {
      await startOutboxDeliveryWorkflow(env, quoteRequestId);
    }
  }
  return settled;
};

/**
 * The `FederatePendingStatuses` job: try each owed activity that is due, a
 * page at a time, the longest waiting first. A try that throws counts as a
 * failed one. The run queues one retry, after the shortest wait it found,
 * and follows a full page at once unless a row's write failed.
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
    const waits: number[] = [];
    for (const pending of due.value) {
      let outcome: TryOutcome;
      try {
        outcome = await federate(env, identity.value, pending);
      } catch (cause) {
        console.error(
          JSON.stringify({
            kind: "StatusFederationTryThrew",
            statusId: pending.statusId,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
        outcome = await failed(env, pending, "thrown");
      }
      if (outcome.kind === "Again") {
        waits.push(outcome.delaySeconds);
      } else if (outcome.kind === "WriteFailed") {
        waits.push(WRITE_FAILED_DELAY_SECONDS);
      }
    }
    // Rows whose write failed are still due: following at once would try
    // them again at once.
    const chained = due.value.length === PAGE && !waits.includes(WRITE_FAILED_DELAY_SECONDS);
    if (chained) {
      await queueRetry(env, 0);
    }
    if (waits.length > 0) {
      await queueRetry(env, Math.min(...waits));
    }
    return { outcome: "ok", size: due.value.length, chained };
  });
