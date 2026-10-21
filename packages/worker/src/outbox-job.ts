import { assertNever } from "@tstodon/core";
import { type LocalStatus, OutboxJob, type OutboxJob as OutboxJobValue } from "@tstodon/domain";
import { ok } from "neverthrow";
import { nowIso } from "./clock";
import { mastodonStatuses } from "./local-status-documents";
import {
  ensureOutboxTarget,
  ensureOutboxTargets,
  findOutboundActivity,
  markOutboundExpanded,
} from "./outbox-store";
import { listExpiredUnnotifiedPolls, markPollExpiryNotified } from "./poll-store";
import { elapsedMs, writeMetric } from "./metrics";
import { suspendedDomains } from "./admin-domain-block-store";
import { processLinkCardJob, refreshStaleLinkCards } from "./link-card";
import { processPushJob } from "./push-delivery";
import { indexMissingRemoteTags } from "./remote-status-store";
import { publishDueScheduledStatuses } from "./scheduled-status-publish";
import { findRemoteActorsByUris, listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";
import { startOutboxDeliveryWorkflow } from "./delivery";

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

const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

const audienceOf = (value: unknown): string[] => {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return [Reflect.get(value, "to"), Reflect.get(value, "cc")].flatMap((field) =>
    typeof field === "string"
      ? [field]
      : Array.isArray(field)
        ? field.filter((entry): entry is string => typeof entry === "string")
        : [],
  );
};

/**
 * Who an outbound activity goes to, read from its addressing (the object's
 * `to`/`cc` and the activity's own): followers when it addresses the public
 * or this instance's followers collection, and each remote actor it names.
 * An activity without addressing (a boost) goes to followers.
 */
export const outboundAudience = (
  payloadJson: string,
  localHost: string,
): Readonly<{ followers: boolean; actorUris: ReadonlyArray<string> }> => {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { followers: true, actorUris: [] };
  }
  const object =
    typeof payload === "object" && payload !== null ? Reflect.get(payload, "object") : undefined;
  const audience = [...audienceOf(payload), ...audienceOf(object)];
  if (audience.length === 0) {
    return { followers: true, actorUris: [] };
  }
  // `localHost` may carry a port, as the follower filter below compares hosts.
  const isLocal = (uri: string): boolean => {
    try {
      return new URL(uri).host.toLowerCase() === localHost.toLowerCase();
    } catch {
      return false;
    }
  };
  const followers = audience.some(
    (uri) => uri === PUBLIC_COLLECTION || (uri.endsWith("/followers") && isLocal(uri)),
  );
  const actorUris = [
    ...new Set(
      audience.filter(
        (uri) => uri !== PUBLIC_COLLECTION && !uri.endsWith("/followers") && !isLocal(uri),
      ),
    ),
  ];
  return { followers, actorUris };
};

/** `retry` asks the queue to redeliver the message. */
export type OutboxJobOutcome = "ok" | "retry";

export const processOutboxJob = async (
  env: Env,
  job: OutboxJobValue,
): Promise<OutboxJobOutcome> => {
  switch (job.kind) {
    case "ProcessExpiredPolls":
      await processExpiredPolls(env);
      return "ok";
    case "RefreshLinkCards":
      await refreshStaleLinkCards(env);
      return "ok";
    case "BackfillRemoteTags":
      await indexMissingRemoteTags(env.DB);
      return "ok";
    case "PublishScheduledStatuses":
      await publishDueScheduledStatuses(env);
      return "ok";
    case "ProcessLinkCard":
      return processLinkCardJob(env, job);
    case "DeliverPush":
      return processPushJob(env, job);
    case "ExpandFollowers": {
      const startedAt = Date.now();
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr() || !activity.value) {
        return "ok";
      }
      const identity = parseInstanceIdentity(env);
      const sameHost = identity.isOk() ? identity.value.domain : "";
      const audience = outboundAudience(activity.value.payload_json, sameHost);
      const remoteFollowers = audience.followers
        ? await listAcceptedRemoteFollowerInboxes(env.DB, activity.value.account_id)
        : ok([]);
      const addressed = await findRemoteActorsByUris(env.DB, audience.actorUris);
      const candidateInboxes = [
        ...(remoteFollowers.isOk() ? remoteFollowers.value : []),
        ...(addressed.isOk() ? [...addressed.value.values()] : []).map(
          (actor) => actor.sharedInboxUri ?? actor.inboxUri,
        ),
      ];
      const suspended = await suspendedDomains(env.DB);
      const allowHosts = await federationAllowHosts(env);
      const remoteInboxes = [
        ...new Set(
          candidateInboxes.filter((inbox) => {
            try {
              const host = new URL(inbox).host.toLowerCase();
              return host !== sameHost && !suspended.has(host) && allowListAdmits(allowHosts, host);
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
        return "ok";
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
      return "ok";
    }
    case "DeliverTarget": {
      const target = await ensureOutboxTarget(env.DB, job.activityId, job.inboxUrl);
      if (target.isErr()) {
        return "ok";
      }
      await startOutboxDeliveryWorkflow(env, job);
      return "ok";
    }
    default:
      return assertNever(job);
  }
};
