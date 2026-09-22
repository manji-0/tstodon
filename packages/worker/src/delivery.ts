import {
  ActivityId,
  DeliveryAttemptOutcome,
  InstanceIdentity,
  OutboxJob,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  type OutboxJob as OutboxJobValue,
} from "@tstodon/domain";
import { findAccountById } from "./account-store";
import { nowIso } from "./clock";
import { signInboxRequest } from "./http-signature";
import { mastodonStatus } from "./mastodon";
import {
  ensureOutboxTarget,
  findOutboundActivity,
  insertOutboundActivity,
  markOutboundExpanded,
} from "./outbox-store";
import {
  listExpiredUnnotifiedPolls,
  markPollExpiryNotified,
} from "./poll-store";
import { listAcceptedFollowerIds } from "./social-store";
import { listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";

type DeliverTargetJob = Extract<OutboxJobValue, { kind: "DeliverTarget" }>;

export const enqueueLocalActivity = async (
  env: Env,
  accountId: string,
  kind: string,
  payload: unknown,
): Promise<void> => {
  const inserted = await insertOutboundActivity(env.DB, {
    accountId,
    kind,
    payload,
  });
  if (inserted.isErr()) {
    return;
  }
  const activityId = ActivityId.parse(inserted.value.id);
  if (activityId.isErr()) {
    return;
  }
  await env.OUTBOX_PROCESS_QUEUE.send({
    kind: "ExpandFollowers",
    activityId: activityId.value,
  });
};

export const deliveryWorkflowId = async (
  activityId: string,
  inboxUrl: string,
): Promise<string> => {
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
  for (const poll of expired.value) {
    const status = await findStatusById(env.DB, poll.statusId);
    if (status.isOk() && status.value) {
      const document = await mastodonStatus(
        env,
        identity.value,
        status.value,
        poll.accountId,
      );
      await publishToAccount(env, poll.accountId, {
        kind: "status.update",
        payload: document,
      });
    }
    await markPollExpiryNotified(env.DB, poll.id, notifiedAt);
  }
};

export const processOutboxJob = async (
  env: Env,
  job: OutboxJobValue,
): Promise<void> => {
  switch (job.kind) {
    case "ProcessExpiredPolls":
      await processExpiredPolls(env);
      return;
    case "ExpandFollowers": {
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr() || !activity.value) {
        return;
      }
      const followerIds = await listAcceptedFollowerIds(
        env.DB,
        activity.value.account_id,
      );
      const identity = parseInstanceIdentity(env);
      const remoteTargets: string[] = [];
      if (followerIds.isOk() && identity.isOk()) {
        for (const followerId of followerIds.value) {
          const follower = await findAccountById(env.DB, followerId);
          if (follower.isErr() || !follower.value) {
            continue;
          }
          const inbox = `${InstanceIdentity.actorUrl(identity.value, follower.value.username)}/inbox`;
          remoteTargets.push(inbox);
        }
      }
      const remoteFollowers = await listAcceptedRemoteFollowerInboxes(
        env.DB,
        activity.value.account_id,
      );
      if (remoteFollowers.isOk()) {
        remoteTargets.push(...remoteFollowers.value);
      }
      const sameHost = identity.isOk() ? identity.value.domain : "";
      const remoteInboxes = remoteTargets.filter((inbox) => {
        try {
          return new URL(inbox).host !== sameHost;
        } catch {
          return false;
        }
      });
      await markOutboundExpanded(env.DB, job.activityId, remoteInboxes.length);
      for (const inboxUrl of remoteInboxes) {
        const parsedInbox = OutboxJob.parse({
          kind: "DeliverTarget",
          activityId: job.activityId,
          inboxUrl,
        });
        if (parsedInbox.isErr()) {
          continue;
        }
        const target = await ensureOutboxTarget(
          env.DB,
          job.activityId,
          parsedInbox.value.inboxUrl,
        );
        if (target.isErr()) {
          continue;
        }
        await startOutboxDeliveryWorkflow(env, parsedInbox.value);
      }
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
