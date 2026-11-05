import { assertNever } from "@tstodon/core";
import { Hostname, OutboxJob, type OutboxJob as OutboxJobValue } from "@tstodon/domain";
import { ok } from "neverthrow";
import {
  ensureOutboxTarget,
  ensureOutboxTargets,
  findOutboundActivity,
  markOutboundExpanded,
} from "./outbox-store";
import { processExpiredPolls } from "./poll-expiry";
import { elapsedMs, measureJobPage, writeMetric } from "./metrics";
import { suspendedDomains } from "./admin-domain-block-store";
import { processLinkCardJob, refreshStaleLinkCards } from "./link-card";
import { processDistributePollUpdateJob } from "./poll-update";
import { processPushJob } from "./push-delivery";
import { processFanOutHomeJob, processFanOutRemovedStatusesJob } from "./home-fan-out";
import { processFanOutPublicJob } from "./public-fan-out";
import { processCsvImportJob } from "./csv-import-apply";
import { processSeverBlockedDomainFollowsJob } from "./account-domain-block";
import { processMoveFollowsJob } from "./remote-move";
import { processBackfillRemoteOutboxJob } from "./remote-outbox-backfill";
import { processBackfillRemoteThreadJob } from "./remote-thread-backfill";
import { indexMissingRemoteTags } from "./remote-status-store";
import { rekeyLegacyMediaBatch } from "./media-rekey";
import { publishDueScheduledStatuses } from "./scheduled-status-publish";
import { cleanUpAccountStatuses, queueStatusesCleanup } from "./statuses-cleanup";
import { findRemoteActorsByUris, listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import {
  allowListAdmits,
  federationAllowHosts,
  legacyMediaPolicy,
  parseInstanceIdentity,
} from "./runtime-config";
import { startOutboxDeliveryWorkflow } from "./delivery";
import { parseJsonText } from "./json-column";
import { parseLocalStatusId } from "./activitypub";
import { listPollInteractorUris } from "./remote-interaction-store";

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

/** The `Question` an `Update` carries, by URI: a poll's new counts or an edit of it. */
const updatedQuestionOf = (payload: unknown, object: unknown): string | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Reflect.get(payload, "type") !== "Update" ||
    typeof object !== "object" ||
    object === null ||
    Reflect.get(object, "type") !== "Question"
  ) {
    return undefined;
  }
  const id: unknown = Reflect.get(object, "id");
  return typeof id === "string" ? id : undefined;
};

/**
 * Who an outbound activity goes to, read from its addressing (the object's
 * `to`/`cc` and the activity's own): followers when it addresses the public
 * or this instance's followers collection, and each remote actor it names.
 * An activity without addressing (a boost) goes to followers.
 * `updatedQuestion` is the poll an `Update(Question)` carries, whose voters
 * and boosters hear it too.
 */
export const outboundAudience = (
  payloadJson: string,
  localHost: string,
): Readonly<{
  followers: boolean;
  actorUris: ReadonlyArray<string>;
  updatedQuestion: string | undefined;
}> => {
  const parsed = parseJsonText(payloadJson);
  if (parsed.isErr()) {
    return { followers: true, actorUris: [], updatedQuestion: undefined };
  }
  const payload = parsed.value;
  const object: unknown =
    typeof payload === "object" && payload !== null ? Reflect.get(payload, "object") : undefined;
  const updatedQuestion = updatedQuestionOf(payload, object);
  const audience = [...audienceOf(payload), ...audienceOf(object)];
  if (audience.length === 0) {
    return { followers: true, actorUris: [], updatedQuestion };
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
  return { followers, actorUris, updatedQuestion };
};

/** Would {@link outboundAudience} find any remote recipient for this activity? */
export const reachesRemoteInboxes = (activity: unknown, localHost: string): boolean => {
  const audience = outboundAudience(JSON.stringify(activity), localHost);
  return audience.followers || audience.actorUris.length > 0;
};

/** `retry` asks the queue to redeliver the message. */
export type OutboxJobOutcome = "ok" | "retry";

export const processOutboxJob = async (
  env: Env,
  job: OutboxJobValue,
): Promise<OutboxJobOutcome> => {
  switch (job.kind) {
    case "ProcessExpiredPolls":
      return processExpiredPolls(env);
    case "RefreshLinkCards":
      await refreshStaleLinkCards(env);
      return "ok";
    case "BackfillRemoteTags":
      await indexMissingRemoteTags(env.DB);
      return "ok";
    case "RekeyLegacyMedia":
      return measureJobPage(env, job.kind, async () => {
        const batch = await rekeyLegacyMediaBatch(env, legacyMediaPolicy(env), job.afterId);
        if (batch.nextAfterId !== undefined) {
          await env.OUTBOX_PROCESS_QUEUE.send({
            kind: "RekeyLegacyMedia",
            afterId: batch.nextAfterId,
          });
        }
        return { outcome: "ok", size: batch.scanned, chained: batch.nextAfterId !== undefined };
      });
    case "CleanUpStatuses":
      await queueStatusesCleanup(env);
      return "ok";
    case "CleanUpAccountStatuses":
      // One pass per account; the cron queues the next run, so it never chains.
      return measureJobPage(env, job.kind, async () => ({
        outcome: "ok",
        size: (await cleanUpAccountStatuses(env, job.accountId)).scanned,
        chained: false,
      }));
    case "PublishScheduledStatuses":
      await publishDueScheduledStatuses(env);
      return "ok";
    case "ProcessLinkCard":
      return processLinkCardJob(env, job);
    case "DistributePollUpdate":
      return processDistributePollUpdateJob(env, job);
    case "DeliverPush":
      return processPushJob(env, job);
    case "MoveFollows":
      return processMoveFollowsJob(env, job);
    case "ProcessCsvImport":
      return processCsvImportJob(env, job);
    case "SeverBlockedDomainFollows":
      return processSeverBlockedDomainFollowsJob(env, job);
    case "FanOutHome":
      return processFanOutHomeJob(env, job);
    case "FanOutRemovedStatuses":
      return processFanOutRemovedStatusesJob(env, job);
    case "FanOutPublic":
      return processFanOutPublicJob(env, job);
    case "BackfillRemoteOutbox":
      return processBackfillRemoteOutboxJob(env, job);
    case "BackfillRemoteThread":
      return processBackfillRemoteThreadJob(env, job);
    case "ExpandFollowers": {
      const startedAt = Date.now();
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr() || !activity.value) {
        return "ok";
      }
      const identity = parseInstanceIdentity(env);
      const sameHost = identity.isOk() ? identity.value.domain : "";
      const audience = outboundAudience(activity.value.payload_json, sameHost);
      // The instance actor has no followers.
      const remoteFollowers =
        audience.followers && activity.value.account_id !== null
          ? await listAcceptedRemoteFollowerInboxes(env.DB, activity.value.account_id)
          : ok([]);
      // As Mastodon's `DistributePollUpdateWorker`, a local poll's `Update`
      // also goes to its remote voters and boosters, followers or not.
      const pollStatusId =
        audience.updatedQuestion !== undefined && identity.isOk()
          ? parseLocalStatusId(identity.value, audience.updatedQuestion)
          : undefined;
      const interactors =
        pollStatusId === undefined ? ok([]) : await listPollInteractorUris(env.DB, pollStatusId);
      const addressed = await findRemoteActorsByUris(env.DB, [
        ...audience.actorUris,
        ...(interactors.isOk() ? interactors.value : []),
      ]);
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
              return (
                host !== sameHost &&
                !suspended.has(Hostname.ofAuthority(host)) &&
                allowListAdmits(allowHosts, host)
              );
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
