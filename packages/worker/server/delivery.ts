import type { ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import {
  ActivityId,
  CoveredHosts,
  DeliveryAttemptOutcome,
  type DeliveryAttemptOutcome as DeliveryAttemptOutcomeValue,
  FollowersSynchronization,
  Hostname,
  InstanceIdentity,
  type LocalAccount,
  type OutboxJob as OutboxJobValue,
  Username,
} from "@tstodon/domain";
import type { SensitiveValue } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { deliveredActivity } from "./own-activity-signature";
import { fetchDoubleKnocking, signInboxRequest } from "./http-signature";
import { instanceActorKeyId, instanceActorKeys } from "./instance-actor";
import { unavailableDeliveryDomains } from "./delivery-domain-health-store";
import {
  ensureOutboxTargets,
  findOutboundActivityWithSigner,
  insertSkippedOutboxTargets,
  insertOutboundActivity,
  markOutboundExpanded,
  type OutboundActivityWithSignerRow,
  type OutboundSigner,
} from "./outbox-store";
import { elapsedMs, writeMetric } from "./metrics";
import type { OutboxWorkflowParams } from "./outbox-delivery-workflow";
import { suspendedDomains } from "./admin-domain-block-store";
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { checkFederatedHost } from "./federated-fetch";
import {
  collectionSynchronizationHeader,
  followersSynchronizationDisabled,
} from "./followers-synchronization";

type DeliverTargetJob = Extract<OutboxJobValue, { kind: "DeliverTarget" }>;

export type EnqueueLocalActivityError =
  | RepositoryError
  | Readonly<{ kind: "InvalidActivityId" }>
  | Readonly<{ kind: "QueueSendFailed"; message: string }>;

/**
 * Store `account`'s activity for its followers, Linked-Data-signed when
 * Mastodon would sign it ({@link deliveredActivity}), and queue the job that
 * lists their inboxes. With `synchronizeFollowers`, each POST carries a
 * `Collection-Synchronization` header (`synchronizesFollowers`).
 */
export const enqueueLocalActivity = async (
  env: Env,
  account: LocalAccount,
  kind: string,
  payload: ApActivityDocumentJSON,
  options: Readonly<{ synchronizeFollowers?: boolean }> = {},
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const accountId = account.id;
  const inserted = await insertOutboundActivity(env.DB, {
    signer: { kind: "Account", accountId },
    kind,
    payload: await deliveredActivity(env, account, payload),
    audience: "Followers",
    synchronizeFollowers: options.synchronizeFollowers === true,
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
  account: LocalAccount,
  kind: string,
  payload: ApActivityDocumentJSON,
  inboxUrl: string,
  reach: DeliveryReach = "Federating",
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(env, kind, { kind: "Own", account, activity: payload }, [inboxUrl], reach);

/**
 * {@link enqueueTargetedActivity} to several inboxes as one activity, for an
 * audience that is not the signer's followers.
 */
export const enqueueActivityToInboxes = (
  env: Env,
  account: LocalAccount,
  kind: string,
  payload: ApActivityDocumentJSON,
  inboxUrls: ReadonlyArray<string>,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(env, kind, { kind: "Own", account, activity: payload }, inboxUrls);

/** {@link enqueueTargetedActivity}, signed by the instance actor rather than a user. */
export const enqueueInstanceActorActivity = (
  env: Env,
  kind: string,
  payload: ApActivityDocumentJSON,
  inboxUrl: string,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  enqueueSignedActivity(
    env,
    kind,
    { kind: "AsIs", signer: { kind: "InstanceActor" }, body: payload },
    [inboxUrl],
  );

/**
 * Which inboxes an activity may reach: those of the servers this one
 * federates with, or also those on a suspended domain. Only the notices a
 * domain suspension sends take the second: Mastodon's `DeleteAccountService`
 * delivers its `Reject` and `Undo` of each follow to the account it purges,
 * after its domain is suspended.
 */
export type DeliveryReach = "Federating" | "AlsoSuspended";

/**
 * `inboxUrls` without repeats and without those this server never contacts:
 * on a suspended domain (unless `reach` says otherwise), or outside the
 * federation allow list.
 */
export const admittedInboxes = async (
  env: Env,
  inboxUrls: ReadonlyArray<string>,
  federationAllowList?: ReadonlySet<string>,
  reach: DeliveryReach = "Federating",
): Promise<string[]> => {
  const [suspended, allowHosts] = await Promise.all([
    reach === "AlsoSuspended" ? CoveredHosts.none : suspendedDomains(env.DB),
    federationAllowList ?? federationAllowHosts(env),
  ]);
  return [...new Set(inboxUrls)].filter((inboxUrl) => {
    const inboxHost = Hostname.ofUri(inboxUrl);
    return (
      !inboxHost ||
      (!CoveredHosts.covers(suspended, inboxHost) && allowListAdmits(allowHosts, inboxHost))
    );
  });
};

/** What an activity sent to named inboxes carries. */
type OutboundBody =
  /** A local account's own activity, signed as Mastodon would sign it ({@link deliveredActivity}). */
  | Readonly<{ kind: "Own"; account: LocalAccount; activity: ApActivityDocumentJSON }>
  /** A body delivered as it is: a forward, or the instance actor's activity. */
  | Readonly<{ kind: "AsIs"; signer: OutboundSigner; body: unknown }>;

const enqueueSignedActivity = async (
  env: Env,
  kind: string,
  outbound: OutboundBody,
  inboxUrls: ReadonlyArray<string>,
  reach: DeliveryReach = "Federating",
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const allowHosts = await federationAllowHosts(env);
  // An inbox this server never contacts is dropped quietly, before anything
  // is signed for it.
  const admitted = await admittedInboxes(env, inboxUrls, allowHosts, reach);
  if (admitted.length === 0) {
    return ok(undefined);
  }
  const signer: OutboundSigner =
    outbound.kind === "Own" ? { kind: "Account", accountId: outbound.account.id } : outbound.signer;
  const inserted = await insertOutboundActivity(env.DB, {
    signer,
    kind,
    payload:
      outbound.kind === "Own"
        ? await deliveredActivity(env, outbound.account, outbound.activity, allowHosts)
        : outbound.body,
    audience: "Inboxes",
  });
  if (inserted.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxEnqueueInsertFailed",
        signer: signer.kind,
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

/**
 * The last step of an expansion job (`ExpandFollowers`, `ExpandForward`):
 * deliver the activity to `candidateInboxes` but those on this host, on a
 * suspended domain or outside the allow list, each once. The fan-out row is
 * marked expanded; an inbox on a domain marked unavailable gets a `Skipped`
 * target, the rest are stored and the delivery Workflow starts. One
 * `outbox.expand` point (doubles: target count, ms, ok flag, skipped count).
 */
export const deliverExpandedActivity = async (
  env: Env,
  activityId: string,
  candidateInboxes: ReadonlyArray<string>,
  startedAt: number,
): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  const sameHost = identity.isOk() ? identity.value.domain : "";
  const suspended = await suspendedDomains(env.DB);
  const allowHosts = await federationAllowHosts(env);
  const remoteInboxes = [
    ...new Set(
      candidateInboxes.filter((inbox) => {
        try {
          const host = new URL(inbox).host.toLowerCase();
          return (
            host !== sameHost &&
            !CoveredHosts.covers(suspended, Hostname.ofAuthority(host)) &&
            allowListAdmits(allowHosts, host)
          );
        } catch {
          return false;
        }
      }),
    ),
  ];
  await markOutboundExpanded(env.DB, activityId, remoteInboxes.length);
  const { deliver, skipped } = await partitionByDomainAvailability(env.DB, remoteInboxes);
  const skippedTargets = await recordSkippedTargets(env, activityId, skipped, "expand");
  const ensured = skippedTargets.isErr()
    ? skippedTargets
    : await ensureOutboxTargets(env.DB, activityId, deliver);
  if (ensured.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxExpandTargetsFailed",
        activityId,
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
  if (deliver.length > 0) {
    await startOutboxDeliveryWorkflow(env, activityId);
  }
  writeMetric(
    env,
    "outbox.expand",
    [remoteInboxes.length, elapsedMs(startedAt), 1, skipped.length],
    ["ok"],
  );
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
  logSkippedTargets(env, activityId, inboxUrls, source);
  return ok(undefined);
};

/**
 * The `OutboxDeliverySkipped` line and the `outbox.skip` point of the targets
 * of an activity stored `Skipped` for an unavailable domain.
 */
export const logSkippedTargets = (
  env: Env,
  activityId: string,
  inboxUrls: ReadonlyArray<string>,
  source: "targeted" | "expand",
): void => {
  if (inboxUrls.length === 0) {
    return;
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

/**
 * The key that signs `activity`: its account's or a deleted account's, read
 * with it, or the instance actor's.
 */
const signingKey = async (
  env: Env,
  identity: InstanceIdentity,
  activity: OutboundActivityWithSignerRow,
): Promise<SigningKey> => {
  if (activity.signer_username === null || activity.signer_private_key_jwk === null) {
    if (activity.account_id !== null) {
      return { kind: "Missing" };
    }
    const keys = await instanceActorKeys(env.DB);
    return keys.isOk()
      ? {
          kind: "Found",
          keyId: instanceActorKeyId(identity),
          privateKeyJwk: keys.value.privateKeyJwk,
        }
      : { kind: "Unavailable" };
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
export const POST_TIMEOUT_MS = 60_000;

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
  const allowHosts = await federationAllowHosts(env);
  const instanceDomain = identity.value.domain;
  const { account_id: signerId, signer_username: signerUsername } = activity.value;
  const synchronizing =
    activity.value.synchronize_followers === 1 &&
    signerId !== null &&
    signerUsername !== null &&
    !followersSynchronizationDisabled(env)
      ? { id: signerId, username: signerUsername }
      : undefined;
  // The header depends on the inbox's scheme and authority only: inboxes on
  // one host posted in this step share one read of the followers there.
  const headersByPrefix = new Map<string, ReturnType<typeof collectionSynchronizationHeader>>();
  const synchronizationFor = (
    account: Readonly<{ id: string; username: string }>,
    inboxUrl: string,
  ): ReturnType<typeof collectionSynchronizationHeader> => {
    const prefix = FollowersSynchronization.uriPrefix(inboxUrl) ?? "";
    const known = headersByPrefix.get(prefix);
    if (known !== undefined) {
      return known;
    }
    const header = collectionSynchronizationHeader(env.DB, identity.value, account, inboxUrl);
    headersByPrefix.set(prefix, header);
    // A failed read is tried again for the next inbox.
    void header.then((read) => read.isErr() && headersByPrefix.delete(prefix));
    return header;
  };
  return async (inboxUrl) => {
    const inbox = URL.parse(inboxUrl);
    if (inbox === null || (inbox.protocol !== "https:" && inbox.protocol !== "http:")) {
      return local(DeliveryAttemptOutcome.forHttpStatus(400));
    }
    // The inbox URL comes from a remote actor document: the same guard as
    // every federated fetch, checked again at each attempt because a name can
    // come to resolve to a private address after it was stored.
    const admitted = await checkFederatedHost(inbox.hostname, instanceDomain, { allowHosts });
    if (admitted === "Unavailable") {
      return local(DeliveryAttemptOutcome.Local);
    }
    // DNS says the name does not resolve: the remote is as unreachable as if
    // the connection failed, which is what its domain health should count.
    if (admitted === "Unresolvable") {
      return { outcome: DeliveryAttemptOutcome.Network, remote: true };
    }
    if (admitted === "Refused") {
      console.warn(JSON.stringify({ kind: "OutboxInboxRefused", activityId, host: inbox.host }));
      return local(DeliveryAttemptOutcome.forHttpStatus(400));
    }
    const synchronization =
      synchronizing === undefined
        ? ok(undefined)
        : await synchronizationFor(synchronizing, inboxUrl);
    if (synchronization.isErr()) {
      return local(DeliveryAttemptOutcome.Local);
    }
    const synchronizationHeader = synchronization.value;
    // Each POST has its own timeout, as Mastodon's `Request` times each one.
    const post = async (headers: Headers): Promise<Response> => {
      if (synchronizationHeader !== undefined) {
        headers.set("Collection-Synchronization", synchronizationHeader);
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), POST_TIMEOUT_MS);
      try {
        return await fetch(inbox, {
          method: "POST",
          headers,
          body,
          // Workers' fetch would follow a redirect past the host guard. Like
          // any other non-2xx answer that is not unsalvageable, a 3xx is
          // retried, as Mastodon's DeliveryWorker raises on it.
          redirect: "manual",
          signal: timeout.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      // Draft-cavage, then RFC 9421 when that is answered 400 or 401.
      const sent = await fetchDoubleKnocking(
        (scheme) => signInboxRequest(inbox, key.privateKeyJwk, key.keyId, body, new Date(), scheme),
        post,
      );
      if (sent.isErr()) {
        return local(DeliveryAttemptOutcome.forHttpStatus(400));
      }
      const response = sent.value;
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
};

export const attemptInboxDelivery = async (
  env: Env,
  job: DeliverTargetJob,
): Promise<DeliveryAttemptOutcomeValue> =>
  (await (await prepareInboxDelivery(env, job.activityId))(job.inboxUrl)).outcome;
