import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import {
  ActivityId,
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  Hostname,
  Username,
} from "@tstodon/domain";
import type { SensitiveValue } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { signInboxRequest } from "./http-signature";
import { instanceActorKeyId, instanceActorKeys } from "./instance-actor";
import { unavailableDeliveryDomains } from "./delivery-domain-health-store";
import {
  ensureOutboxTargets,
  findOutboundActivityWithSigner,
  insertSkippedOutboxTargets,
  insertOutboundActivity,
  type OutboundActivityWithSignerRow,
  type OutboundSigner,
} from "./outbox-store";
import { writeMetric } from "./metrics";
import type { OutboxWorkflowParams } from "./outbox-delivery-workflow";
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
  const { deliver, skipped } = await partitionByDomainAvailability(env.DB, admitted);
  const targets = await ensureOutboxTargets(env.DB, activityId.value, deliver);
  if (targets.isErr()) {
    return err(targets.error);
  }
  const skippedTargets = await recordSkippedTargets(env, activityId.value, skipped, "targeted");
  if (skippedTargets.isErr()) {
    return err(skippedTargets.error);
  }
  for (const inboxUrl of deliver) {
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

/**
 * Split inboxes into those to deliver to and those on a domain marked
 * unavailable (`DeliveryDomainHealth`), whose targets are recorded `Skipped`.
 */
export const partitionByDomainAvailability = async (
  db: D1Database,
  inboxUrls: ReadonlyArray<string>,
): Promise<Readonly<{ deliver: string[]; skipped: string[] }>> => {
  const unavailable = await unavailableDeliveryDomains(db);
  const deliver: string[] = [];
  const skipped: string[] = [];
  for (const inboxUrl of inboxUrls) {
    const host = Hostname.ofUri(inboxUrl);
    (host !== undefined && unavailable.has(host) ? skipped : deliver).push(inboxUrl);
  }
  return { deliver, skipped };
};

/**
 * Store the targets left out for an unavailable domain as `Skipped` /
 * `DomainUnavailable`, with one `OutboxDeliverySkipped` line and one
 * `outbox.skip` point per activity.
 */
export const recordSkippedTargets = async (
  env: Env,
  activityId: string,
  inboxUrls: ReadonlyArray<string>,
  source: "targeted" | "expand",
): Promise<Result<void, RepositoryError>> => {
  if (inboxUrls.length === 0) {
    return ok(undefined);
  }
  const inserted = await insertSkippedOutboxTargets(env.DB, activityId, inboxUrls);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  console.log(
    JSON.stringify({
      kind: "OutboxDeliverySkipped",
      activityId,
      reason: "DomainUnavailable",
      targets: inboxUrls.length,
      domains: [...new Set(inboxUrls.map((url) => Hostname.ofUri(url) ?? ""))].slice(0, 20),
    }),
  );
  writeMetric(env, "outbox.skip", [inboxUrls.length], [source, "DomainUnavailable"]);
  return ok(undefined);
};

/** The part of the `OUTBOX_DELIVERY_WORKFLOW` binding that starts an instance. */
export type DeliveryWorkflowCreate = Readonly<{
  create: (options: Readonly<{ id: string; params: OutboxWorkflowParams }>) => Promise<unknown>;
}>;

/** Start the target's delivery Workflow; false (logged) when Workflows refused it. */
export const startOutboxDeliveryWorkflow = async (
  env: Env,
  job: DeliverTargetJob,
  workflows: DeliveryWorkflowCreate = env.OUTBOX_DELIVERY_WORKFLOW,
): Promise<boolean> => {
  const id = await deliveryWorkflowId(job.activityId, job.inboxUrl);
  try {
    await workflows.create({
      id,
      params: {
        kind: "DeliverTarget" as const,
        activityId: job.activityId,
        inboxUrl: job.inboxUrl,
      },
    });
    return true;
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "OutboxWorkflowCreateFailed",
        activityId: job.activityId,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return false;
  }
};

type SigningKey =
  | Readonly<{ kind: "Found"; keyId: string; privateKeyJwk: SensitiveValue<string> }>
  /** The signing account is gone: the activity can never be delivered. */
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "Unavailable" }>;

/** The key that signs `activity`: its account's, read with it, or the instance actor's. */
const signingKey = async (
  env: Env,
  identity: InstanceIdentity,
  activity: OutboundActivityWithSignerRow,
): Promise<SigningKey> => {
  if (activity.account_id === null) {
    const keys = await instanceActorKeys(env.DB);
    return keys.isOk()
      ? {
          kind: "Found",
          keyId: instanceActorKeyId(identity),
          privateKeyJwk: keys.value.privateKeyJwk,
        }
      : { kind: "Unavailable" };
  }
  if (activity.signer_username === null || activity.signer_private_key_jwk === null) {
    return { kind: "Missing" };
  }
  const username = Username.parse(activity.signer_username);
  if (username.isErr()) {
    return { kind: "Unavailable" };
  }
  return {
    kind: "Found",
    keyId: `${InstanceIdentity.actorUrl(identity, username.value)}#main-key`,
    privateKeyJwk: activity.signer_private_key_jwk,
  };
};

/**
 * One delivery attempt. `remote` is false when this server settled it without
 * an answer from the inbox (the activity or its signer is gone, the URL does
 * not parse, a local dependency failed): such an outcome says nothing about
 * the remote's health.
 */
export type InboxDeliveryAttempt = Readonly<{
  outcome: DeliveryAttemptOutcomeValue;
  remote: boolean;
}>;

const local = (outcome: DeliveryAttemptOutcomeValue): InboxDeliveryAttempt => ({
  outcome,
  remote: false,
});

export const attemptInboxDeliveryWithEvidence = async (
  env: Env,
  job: DeliverTargetJob,
): Promise<InboxDeliveryAttempt> => {
  const activity = await findOutboundActivityWithSigner(env.DB, job.activityId);
  if (activity.isErr()) {
    return local(DeliveryAttemptOutcome.Local);
  }
  if (!activity.value) {
    return local(DeliveryAttemptOutcome.forHttpStatus(404));
  }
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return local(DeliveryAttemptOutcome.Local);
  }
  const key = await signingKey(env, identity.value, activity.value);
  if (key.kind === "Missing") {
    return local(DeliveryAttemptOutcome.forHttpStatus(404));
  }
  if (key.kind === "Unavailable") {
    return local(DeliveryAttemptOutcome.Local);
  }
  let inbox: URL;
  try {
    inbox = new URL(job.inboxUrl);
  } catch {
    return local(DeliveryAttemptOutcome.forHttpStatus(400));
  }
  const headers = await signInboxRequest(
    inbox,
    key.privateKeyJwk,
    key.keyId,
    activity.value.payload_json,
  );
  if (headers.isErr()) {
    return local(DeliveryAttemptOutcome.forHttpStatus(400));
  }
  try {
    const response = await fetch(inbox, {
      method: "POST",
      headers: headers.value,
      body: activity.value.payload_json,
    });
    return {
      outcome: DeliveryAttemptOutcome.forHttpStatus(
        response.status,
        DeliveryAttemptOutcome.retryAfterSeconds(response.headers.get("retry-after"), Date.now()),
      ),
      remote: true,
    };
  } catch {
    return { outcome: DeliveryAttemptOutcome.Network, remote: true };
  }
};

export const attemptInboxDelivery = async (
  env: Env,
  job: DeliverTargetJob,
): Promise<DeliveryAttemptOutcomeValue> =>
  (await attemptInboxDeliveryWithEvidence(env, job)).outcome;
