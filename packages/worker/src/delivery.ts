import {
  ActivityId,
  DeliveryAttemptOutcome,
  InstanceIdentity,
  OutboxJob,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  type LocalStatus,
  type OutboxJob as OutboxJobValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { signInboxRequest } from "./http-signature";
import { mastodonStatuses } from "./mastodon";
import {
  ensureOutboxTarget,
  ensureOutboxTargets,
  findOutboundActivity,
  insertOutboundActivity,
  markOutboundExpanded,
} from "./outbox-store";
import { listExpiredUnnotifiedPolls, markPollExpiryNotified } from "./poll-store";
import { elapsedMs, writeMetric } from "./metrics";
import { listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";

type DeliverTargetJob = Extract<OutboxJobValue, { kind: "DeliverTarget" }>;

export type EnqueueLocalActivityError =
  | RepositoryError
  | Readonly<{ kind: "InvalidActivityId" }>
  | Readonly<{ kind: "QueueSendFailed"; message: string }>;

export const enqueueLocalActivity = async (
  env: Env,
  accountId: string,
  kind: string,
  payload: unknown,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const inserted = await insertOutboundActivity(env.DB, {
    accountId,
    kind,
    payload,
  });
  if (inserted.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueInsertFailed",
        accountId,
        activityKind: kind,
        message: inserted.error.message,
      }),
    );
    return err(inserted.error);
  }
  const activityId = ActivityId.parse(inserted.value.id);
  if (activityId.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueInvalidActivityId",
        accountId,
        rawId: inserted.value.id,
      }),
    );
    return err({ kind: "InvalidActivityId" });
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send({
      kind: "ExpandFollowers",
      activityId: activityId.value,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueQueueSendFailed",
        accountId,
        activityId: activityId.value,
        message,
      }),
    );
    return err({ kind: "QueueSendFailed", message });
  }
  writeMetric(env, "outbox.enqueue", [1], [kind]);
  return ok(undefined);
};

/** Insert outbound activity and deliver to one inbox (Accept, etc.) without ExpandFollowers. */
export const enqueueTargetedActivity = async (
  env: Env,
  accountId: string,
  kind: string,
  payload: unknown,
  inboxUrl: string,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const inserted = await insertOutboundActivity(env.DB, {
    accountId,
    kind,
    payload,
  });
  if (inserted.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueInsertFailed",
        accountId,
        activityKind: kind,
        message: inserted.error.message,
      }),
    );
    return err(inserted.error);
  }
  const activityId = ActivityId.parse(inserted.value.id);
  if (activityId.isErr()) {
    return err({ kind: "InvalidActivityId" });
  }
  const target = await ensureOutboxTarget(env.DB, activityId.value, inboxUrl);
  if (target.isErr()) {
    return err(target.error);
  }
  const deliver = OutboxJob.parse({
    kind: "DeliverTarget",
    activityId: activityId.value,
    inboxUrl,
  });
  if (deliver.isErr() || deliver.value.kind !== "DeliverTarget") {
    return err({ kind: "InvalidActivityId" });
  }
  await startOutboxDeliveryWorkflow(env, deliver.value);
  writeMetric(env, "outbox.enqueue", [1], [kind, "targeted"]);
  return ok(undefined);
};

export const deliveryWorkflowId = async (activityId: string, inboxUrl: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${activityId}\n${inboxUrl}`),
  );
  const bytes = new Uint8Array(digest).subarray(0, 16);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `outbox-${hex}`;
};

export const startOutboxDeliveryWorkflow = async (
  env: Env,
  job: DeliverTargetJob,
): Promise<void> => {
  const id = await deliveryWorkflowId(job.activityId, job.inboxUrl);
  try {
    await env.OUTBOX_DELIVERY_WORKFLOW.create({
      id,
      params: {
        kind: "DeliverTarget" as const,
        activityId: job.activityId,
        inboxUrl: job.inboxUrl,
      },
    });
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "OutboxWorkflowCreateFailed",
        activityId: job.activityId,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
};

export const attemptInboxDelivery = async (
  env: Env,
  job: DeliverTargetJob,
): Promise<DeliveryAttemptOutcomeValue> => {
  const activity = await findOutboundActivity(env.DB, job.activityId);
  if (activity.isErr() || !activity.value) {
    return DeliveryAttemptOutcome.forHttpStatus(404);
  }
  const account = await findAccountById(env.DB, activity.value.account_id);
  if (account.isErr() || !account.value) {
    return DeliveryAttemptOutcome.forHttpStatus(404);
  }
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return DeliveryAttemptOutcome.TransientFailure;
  }
  let inbox: URL;
  try {
    inbox = new URL(job.inboxUrl);
  } catch {
    return DeliveryAttemptOutcome.forHttpStatus(400);
  }
  const keyId = `${InstanceIdentity.actorUrl(identity.value, account.value.username)}#main-key`;
  const headers = await signInboxRequest(
    inbox,
    account.value.privateKeyJwk.unwrap(),
    keyId,
    activity.value.payload_json,
  );
  if (headers.isErr()) {
    return DeliveryAttemptOutcome.forHttpStatus(400);
  }
  try {
    const response = await fetch(inbox, {
      method: "POST",
      headers: headers.value,
      body: activity.value.payload_json,
    });
    return DeliveryAttemptOutcome.forHttpStatus(response.status);
  } catch {
    return DeliveryAttemptOutcome.TransientFailure;
  }
};

const processExpiredPolls = async (env: Env): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const notifiedAt = nowIso();
  const expired = await listExpiredUnnotifiedPolls(env.DB, notifiedAt, 50);
  if (expired.isErr()) {
    return;
  }
  type Pending = Readonly<{
    pollId: string;
    accountId: string;
    status: LocalStatus;
  }>;
  const pending: Pending[] = [];
  for (const poll of expired.value) {
    const status = await findStatusById(env.DB, poll.statusId);
    if (status.isOk() && status.value) {
      pending.push({ pollId: poll.id, accountId: poll.accountId, status: status.value });
    } else {
      await markPollExpiryNotified(env.DB, poll.id, notifiedAt);
    }
  }
  const byOwner = new Map<string, Pending[]>();
  for (const item of pending) {
    const list = byOwner.get(item.accountId) ?? [];
    list.push(item);
    byOwner.set(item.accountId, list);
  }
  for (const [accountId, items] of byOwner) {
    const documents = await mastodonStatuses(
      env,
      identity.value,
      items.map((item) => item.status),
      accountId,
    );
    const byStatusId = new Map<string, Record<string, unknown>>();
    for (const document of documents) {
      const id = document.id;
      if (typeof id === "string") {
        byStatusId.set(id, document);
      }
    }
    for (const item of items) {
      const document = byStatusId.get(item.status.id);
      if (document) {
        await publishToAccount(env, accountId, {
          kind: "status.update",
          payload: document,
        });
      }
      await markPollExpiryNotified(env.DB, item.pollId, notifiedAt);
    }
  }
};

export const processOutboxJob = async (env: Env, job: OutboxJobValue): Promise<void> => {
  switch (job.kind) {
    case "ProcessExpiredPolls":
      await processExpiredPolls(env);
      return;
    case "ExpandFollowers": {
      const startedAt = Date.now();
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr() || !activity.value) {
        return;
      }
      const identity = parseInstanceIdentity(env);
      const remoteFollowers = await listAcceptedRemoteFollowerInboxes(
        env.DB,
        activity.value.account_id,
      );
      const candidateInboxes = remoteFollowers.isOk() ? remoteFollowers.value : [];
      const sameHost = identity.isOk() ? identity.value.domain : "";
      const remoteInboxes = [
        ...new Set(
          candidateInboxes.filter((inbox) => {
            try {
              return new URL(inbox).host !== sameHost;
            } catch {
              return false;
            }
          }),
        ),
      ];
      await markOutboundExpanded(env.DB, job.activityId, remoteInboxes.length);
      const ensured = await ensureOutboxTargets(env.DB, job.activityId, remoteInboxes);
      if (ensured.isErr()) {
        console.error(
          JSON.stringify({
            kind: "OutboxExpandTargetsFailed",
            activityId: job.activityId,
            message: ensured.error.message,
          }),
        );
        writeMetric(
          env,
          "outbox.expand",
          [remoteInboxes.length, elapsedMs(startedAt), 0],
          ["targets_failed"],
        );
        return;
      }
      for (const inboxUrl of remoteInboxes) {
        const deliver = OutboxJob.parse({
          kind: "DeliverTarget",
          activityId: job.activityId,
          inboxUrl,
        });
        if (deliver.isErr() || deliver.value.kind !== "DeliverTarget") {
          continue;
        }
        await startOutboxDeliveryWorkflow(env, deliver.value);
      }
      // doubles: [remoteTargetCount, expandMs, okFlag]
      writeMetric(env, "outbox.expand", [remoteInboxes.length, elapsedMs(startedAt), 1], ["ok"]);
      return;
    }
    case "DeliverTarget": {
      const target = await ensureOutboxTarget(env.DB, job.activityId, job.inboxUrl);
      if (target.isErr()) {
        return;
      }
      await startOutboxDeliveryWorkflow(env, job);
    }
  }
};
