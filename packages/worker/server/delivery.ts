import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import {
  ActivityId,
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  InstanceIdentity,
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
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

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
  const [suspended, allowHosts] = await Promise.all([
    suspendedDomains(env.DB),
    federationAllowHosts(env),
  ]);
  const admitted = [...new Set(inboxUrls)].filter((inboxUrl) => {
    const inboxHost = Hostname.ofUri(inboxUrl);
    return !inboxHost || (!suspended.has(inboxHost) && allowListAdmits(allowHosts, inboxHost));
  });
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
  if (deliver.length > 0) {
    await startOutboxDeliveryWorkflow(env, activityId.value);
  }
  writeMetric(env, "outbox.enqueue", [1], [kind, "targeted"]);
  return ok(undefined);
};

/** The id of the activity's delivery Workflow instance. */
export const deliveryWorkflowId = async (activityId: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(activityId));
  const hex = [...new Uint8Array(digest).subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `outbox-activity-${hex}`;
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

/**
 * Start the Workflow that delivers the activity to each of its `Queued`
 * targets; false (logged) when Workflows refused it.
 */
export const startOutboxDeliveryWorkflow = async (
  env: Env,
  activityId: string,
  workflows: DeliveryWorkflowCreate = env.OUTBOX_DELIVERY_WORKFLOW,
): Promise<boolean> => {
  try {
    await workflows.create({
      id: await deliveryWorkflowId(activityId),
      params: { kind: "DeliverActivity", activityId },
    });
    return true;
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "OutboxWorkflowCreateFailed",
        activityId,
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

/** Posts the prepared activity to one inbox. */
export type InboxPost = (inboxUrl: string) => Promise<InboxDeliveryAttempt>;

/**
 * A POST that has not answered in this long counts as a network failure, so
 * one silent inbox does not hold up the others delivered in the same step.
 */
const POST_TIMEOUT_MS = 60_000;

/**
 * Read the activity and its signing key once, for posting it to any number
 * of inboxes. An activity that cannot be sent settles every inbox the same
 * way, without an answer from any.
 */
export const prepareInboxDelivery = async (env: Env, activityId: string): Promise<InboxPost> => {
  const settled = (outcome: DeliveryAttemptOutcomeValue): InboxPost => {
    const attempt = local(outcome);
    return async () => attempt;
  };
  const activity = await findOutboundActivityWithSigner(env.DB, activityId);
  if (activity.isErr()) {
    return settled(DeliveryAttemptOutcome.Local);
  }
  if (!activity.value) {
    return settled(DeliveryAttemptOutcome.forHttpStatus(404));
  }
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return settled(DeliveryAttemptOutcome.Local);
  }
  const key = await signingKey(env, identity.value, activity.value);
  if (key.kind === "Missing") {
    return settled(DeliveryAttemptOutcome.forHttpStatus(404));
  }
  if (key.kind === "Unavailable") {
    return settled(DeliveryAttemptOutcome.Local);
  }
  const body = activity.value.payload_json;
  return async (inboxUrl) => {
    let inbox: URL;
    try {
      inbox = new URL(inboxUrl);
    } catch {
      return local(DeliveryAttemptOutcome.forHttpStatus(400));
    }
    const headers = await signInboxRequest(inbox, key.privateKeyJwk, key.keyId, body);
    if (headers.isErr()) {
      return local(DeliveryAttemptOutcome.forHttpStatus(400));
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), POST_TIMEOUT_MS);
    try {
      const response = await fetch(inbox, {
        method: "POST",
        headers: headers.value,
        body,
        signal: timeout.signal,
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
    } finally {
      clearTimeout(timer);
    }
  };
};

export const attemptInboxDelivery = async (
  env: Env,
  job: DeliverTargetJob,
): Promise<DeliveryAttemptOutcomeValue> =>
  (await (await prepareInboxDelivery(env, job.activityId))(job.inboxUrl)).outcome;
