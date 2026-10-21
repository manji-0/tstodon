import {
  ActivityId,
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { signInboxRequest } from "./http-signature";
import { ensureOutboxTarget, findOutboundActivity, insertOutboundActivity } from "./outbox-store";
import { writeMetric } from "./metrics";
import { suspendedDomains } from "./admin-domain-block-store";
import { hostnameOf } from "./domain-block-store";
import { federatesWithHost, parseInstanceIdentity } from "./runtime-config";

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
  // A suspended domain, or one outside the federation allow list, is never
  // contacted; the activity is dropped quietly.
  const inboxHost = hostnameOf(inboxUrl);
  if (
    inboxHost &&
    ((await suspendedDomains(env.DB)).has(inboxHost) || !(await federatesWithHost(env, inboxHost)))
  ) {
    return ok(undefined);
  }
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
