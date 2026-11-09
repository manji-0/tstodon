import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import {
  ActivityId,
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  Hostname,
} from "@tstodon/domain";
import type { SensitiveValue } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { findAccountById } from "./account-store";
import type { RepositoryError } from "./d1";
import { signInboxRequest } from "./http-signature";
import { instanceActorKeyId, instanceActorKeys } from "./instance-actor";
import {
  ensureOutboxTargets,
  findOutboundActivity,
  insertOutboundActivity,
  type OutboundSigner,
  outboundSignerOf,
} from "./outbox-store";
import { writeMetric } from "./metrics";
import { suspendedDomains } from "./admin-domain-block-store";
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
  payload: ApActivityDocumentJSON,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const inserted = await insertOutboundActivity(env.DB, {
    signer: { kind: "Account", accountId },
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
export const enqueueTargetedActivity = (
  env: Env,
  accountId: string,
  kind: string,
  payload: ApActivityDocumentJSON,
  inboxUrl: string,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(env, { kind: "Account", accountId }, kind, payload, [inboxUrl]);

/**
 * {@link enqueueTargetedActivity} to several inboxes as one activity, for an
 * audience that is not the signer's followers.
 */
export const enqueueActivityToInboxes = (
  env: Env,
  accountId: string,
  kind: string,
  payload: ApActivityDocumentJSON,
  inboxUrls: ReadonlyArray<string>,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(env, { kind: "Account", accountId }, kind, payload, inboxUrls);

/**
 * Forward an activity another server signed, as received, to `inboxUrls`
 * (Mastodon's `ActivityPub::Forwarder`): its body is not tstodon's, so it is
 * not typed as one of tstodon's activities.
 */
export const forwardActivityToInboxes = (
  env: Env,
  accountId: string,
  kind: string,
  body: Readonly<Record<string, unknown>>,
  inboxUrls: ReadonlyArray<string>,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(env, { kind: "Account", accountId }, kind, body, inboxUrls);

/** {@link enqueueTargetedActivity}, signed by the instance actor rather than a user. */
export const enqueueInstanceActorActivity = (
  env: Env,
  kind: string,
  payload: ApActivityDocumentJSON,
  inboxUrl: string,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(env, { kind: "InstanceActor" }, kind, payload, [inboxUrl]);

const enqueueSignedActivity = async (
  env: Env,
  signer: OutboundSigner,
  kind: string,
  payload: unknown,
  inboxUrls: ReadonlyArray<string>,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  // A suspended domain, or one outside the federation allow list, is never
  // contacted; the activity is dropped quietly.
  const suspended = await suspendedDomains(env.DB);
  const admitted: string[] = [];
  for (const inboxUrl of new Set(inboxUrls)) {
    const inboxHost = Hostname.ofUri(inboxUrl);
    if (!inboxHost || (!suspended.has(inboxHost) && (await federatesWithHost(env, inboxHost)))) {
      admitted.push(inboxUrl);
    }
  }
  if (admitted.length === 0) {
    return ok(undefined);
  }
  const inserted = await insertOutboundActivity(env.DB, { signer, kind, payload });
  if (inserted.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueInsertFailed",
        signer,
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
  const targets = await ensureOutboxTargets(env.DB, activityId.value, admitted);
  if (targets.isErr()) {
    return err(targets.error);
  }
  for (const inboxUrl of admitted) {
    const deliver = OutboxJob.parse({
      kind: "DeliverTarget",
      activityId: activityId.value,
      inboxUrl,
    });
    if (deliver.isErr() || deliver.value.kind !== "DeliverTarget") {
      return err({ kind: "InvalidActivityId" });
    }
    await startOutboxDeliveryWorkflow(env, deliver.value);
  }
  writeMetric(env, "outbox.enqueue", [1], [kind, "targeted"]);
  return ok(undefined);
};

export const deliveryWorkflowId = async (activityId: string, inboxUrl: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${activityId}\n${inboxUrl}`),
  );
  const hex = [...new Uint8Array(digest).subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

type SigningKey =
  | Readonly<{ kind: "Found"; keyId: string; privateKeyJwk: SensitiveValue<string> }>
  /** The signing account is gone: the activity can never be delivered. */
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "Unavailable" }>;

const signingKey = async (
  env: Env,
  identity: InstanceIdentity,
  signer: OutboundSigner,
): Promise<SigningKey> => {
  switch (signer.kind) {
    case "Account": {
      const account = await findAccountById(env.DB, signer.accountId);
      if (account.isErr()) {
        return { kind: "Unavailable" };
      }
      return account.value
        ? {
            kind: "Found",
            keyId: `${InstanceIdentity.actorUrl(identity, account.value.username)}#main-key`,
            privateKeyJwk: account.value.privateKeyJwk,
          }
        : { kind: "Missing" };
    }
    case "InstanceActor": {
      const keys = await instanceActorKeys(env.DB);
      return keys.isOk()
        ? {
            kind: "Found",
            keyId: instanceActorKeyId(identity),
            privateKeyJwk: keys.value.privateKeyJwk,
          }
        : { kind: "Unavailable" };
    }
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
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return DeliveryAttemptOutcome.TransientFailure;
  }
  const key = await signingKey(env, identity.value, outboundSignerOf(activity.value));
  if (key.kind === "Missing") {
    return DeliveryAttemptOutcome.forHttpStatus(404);
  }
  if (key.kind === "Unavailable") {
    return DeliveryAttemptOutcome.TransientFailure;
  }
  let inbox: URL;
  try {
    inbox = new URL(job.inboxUrl);
  } catch {
    return DeliveryAttemptOutcome.forHttpStatus(400);
  }
  const headers = await signInboxRequest(
    inbox,
    key.privateKeyJwk,
    key.keyId,
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
