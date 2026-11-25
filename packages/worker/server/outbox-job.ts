import { assertNever } from "@tstodon/core";
import type { OutboxJob as OutboxJobValue } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { ensureOutboxTarget, findOutboundActivity } from "./outbox-store";
import { processAwaitPollEnd, processExpiredPolls } from "./poll-expiry";
import { measureJobPage } from "./metrics";
import { processLinkCardJob, refreshStaleLinkCards } from "./link-card";
import {
  processFinishRemoteNoteRecipientJob,
  processNotifyRemoteNoteFollowersJob,
} from "./remote-status-persist";
import { processNotifyLocalNoteFollowersJob } from "./local-note-follower-notifications";
import { processNotifyNoteBoostersJob } from "./note-booster-updates";
import { processDistributePollUpdateJob } from "./poll-update";
import { processPushJob } from "./push-delivery";
import { processFanOutHomeJob, processFanOutRemovedStatusesJob } from "./home-fan-out";
import { processFanOutPublicJob } from "./public-fan-out";
import { processCsvImportJob } from "./csv-import-apply";
import { processSeverBlockedDomainFollowsJob } from "./account-domain-block";
import {
  processRecordDomainBlockLimitsJob,
  processResumeLiftedDomainBlockLimitsJob,
} from "./domain-block-limits";
import { processMoveFollowsJob } from "./remote-move";
import { processBackfillRemoteOutboxJob } from "./remote-outbox-backfill";
import { processBackfillRemoteThreadJob } from "./remote-thread-backfill";
import { processResolveRemoteThreadJob } from "./remote-thread-resolve-job";
import { indexMissingRemoteTags } from "./remote-status-store";
import { vacuumMediaAttachments } from "./media-vacuum";
import { vacuumActivities } from "./activity-vacuum";
import { requeueDeadOutboxJobs } from "./dead-letter-queue";
import { ROTATE_ACTOR_KEYS_PAUSE_SECONDS, rotateActorKeysPage } from "./actor-key-rotation";
import { publishDueScheduledStatuses } from "./scheduled-status-publish";
import { cleanUpAccountStatuses, queueStatusesCleanup } from "./statuses-cleanup";
import {
  findRemoteActorsByUris,
  listAcceptedRemoteFollowerInboxes,
  listAccountReachInboxes,
} from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import { deliverExpandedActivity, startOutboxDeliveryWorkflow } from "./delivery";
import { processExpandForwardJob } from "./activity-forward";
import { parseJsonText } from "./json-column";
import { parseLocalStatusId } from "./activitypub";
import { listPollInteractorInboxes } from "./remote-interaction-store";
import { processAuthorizeFollowRequestsJob } from "./follow-request-approval";
import {
  processResumeSuspendedActorSeverancesJob,
  processSeverSuspendedActorFollowsJob,
} from "./suspended-actor-severance";
import { processSendSeveranceNoticesJob } from "./severance-notices";
import { processPurgeSuspendedActorContentJob } from "./suspended-actor-content";
import { processRefetchAndVerifyQuoteJob, processRefreshQuoteJob } from "./quote-retry-jobs";
import { processRefreshRemoteActorJob } from "./remote-actor-refresh";
import { processFederatePendingStatusesJob } from "./pending-status-federation";
import { processVerifyProfileLinksJob } from "./profile-link-verification";
import { processSynchronizeFollowersJob } from "./remote-followers-synchronization";

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

/** The `type` of a parsed document, or of an embedded object. */
const typeOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, "type") : undefined;

/**
 * Whether the activity is about a local collection or its items (an `Add` or
 * `Remove` of a `featuredCollections` member or of a collection's item, an
 * `Update` of a `FeaturedCollection`, a `Delete` of a `FeatureAuthorization`),
 * which Mastodon sends to the owner's reach (`CollectionRawDistributionWorker`,
 * `AccountRawDistributionWorker`).
 */
const isCollectionActivity = (payload: unknown, object: unknown): boolean => {
  const type = typeOf(payload);
  if (type === "Add" || type === "Remove") {
    const target: unknown =
      typeof payload === "object" && payload !== null ? Reflect.get(payload, "target") : undefined;
    return (
      typeof target === "string" &&
      /\/ap\/users\/[^/]+\/(?:featured_collections|collections\/[^/]+)$/.test(target)
    );
  }
  return (
    (type === "Update" && typeOf(object) === "FeaturedCollection") ||
    (type === "Delete" && typeOf(object) === "FeatureAuthorization")
  );
};

/** Whether the activity is an `Update` whose object is its own actor. */
const isActorUpdate = (payload: unknown, object: unknown): boolean => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Reflect.get(payload, "type") !== "Update"
  ) {
    return false;
  }
  const actor: unknown = Reflect.get(payload, "actor");
  const id: unknown =
    typeof object === "object" && object !== null ? Reflect.get(object, "id") : undefined;
  return typeof actor === "string" && actor === id;
};

/**
 * Who an outbound activity goes to, read from its addressing (the object's
 * `to`/`cc` and the activity's own): followers when it addresses the public
 * or this instance's followers collection, and each remote actor it names.
 * An activity without addressing (a boost) goes to followers.
 * `updatedQuestion` is the poll an `Update(Question)` carries, whose voters
 * and boosters hear it too. `accountReach` says the activity also goes
 * beyond the followers (`AccountReachFinder`): an `Update` of its own actor,
 * as Mastodon's `UpdateDistributionWorker` sends it, or a collection's.
 */
export const outboundAudience = (
  payloadJson: string,
  localHost: string,
): Readonly<{
  followers: boolean;
  actorUris: ReadonlyArray<string>;
  updatedQuestion: string | undefined;
  accountReach: boolean;
}> => {
  const parsed = parseJsonText(payloadJson);
  if (parsed.isErr()) {
    return { followers: true, actorUris: [], updatedQuestion: undefined, accountReach: false };
  }
  const payload = parsed.value;
  const object: unknown =
    typeof payload === "object" && payload !== null ? Reflect.get(payload, "object") : undefined;
  const updatedQuestion = updatedQuestionOf(payload, object);
  const accountReach = isActorUpdate(payload, object) || isCollectionActivity(payload, object);
  const audience = [...audienceOf(payload), ...audienceOf(object)];
  if (audience.length === 0) {
    return { followers: true, actorUris: [], updatedQuestion, accountReach };
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
  return { followers, actorUris, updatedQuestion, accountReach };
};

/** A failed recipient lookup leaves those recipients out; say so in the logs. */
const logExpandLookupFailure = (
  activityId: string,
  lookup: "followers" | "pollInteractors" | "accountReach",
  found: Result<unknown, RepositoryError>,
): void => {
  if (found.isErr()) {
    console.error(
      JSON.stringify({
        kind: "OutboxExpandLookupFailed",
        activityId,
        lookup,
        message: found.error.message,
      }),
    );
  }
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
    case "AwaitPollEnd":
      return processAwaitPollEnd(env, job);
    case "RefreshLinkCards":
      await refreshStaleLinkCards(env);
      return "ok";
    case "BackfillRemoteTags":
      return measureJobPage(env, job.kind, async () => {
        const page = await indexMissingRemoteTags(env.DB);
        if (page.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        if (page.value.chained) {
          await env.OUTBOX_PROCESS_QUEUE.send({ kind: "BackfillRemoteTags" });
        }
        return { outcome: "ok", size: page.value.scanned, chained: page.value.chained };
      });
    case "RecordDomainBlockLimits":
      return processRecordDomainBlockLimitsJob(env, job);
    case "ResumeLiftedDomainBlockLimits":
      return processResumeLiftedDomainBlockLimitsJob(env);
    case "PurgeSuspendedActorContent":
      return processPurgeSuspendedActorContentJob(env, job);
    case "VacuumMediaAttachments":
      return measureJobPage(env, job.kind, async () => {
        const pass = await vacuumMediaAttachments(env);
        if (pass.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        if (pass.value.chained) {
          await env.OUTBOX_PROCESS_QUEUE.send({ kind: "VacuumMediaAttachments" });
        }
        return { outcome: "ok", size: pass.value.deleted, chained: pass.value.chained };
      });
    case "VacuumActivities":
      return measureJobPage(env, job.kind, async () => {
        const pass = await vacuumActivities(env);
        if (pass.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        const { deliveries, outbound, inbox, chained } = pass.value;
        if (chained) {
          await env.OUTBOX_PROCESS_QUEUE.send({ kind: "VacuumActivities" });
        }
        return { outcome: "ok", size: deliveries + outbound + inbox, chained };
      });
    case "RequeueDeadOutboxJobs":
      return requeueDeadOutboxJobs(env, job);
    case "RotateActorKeys":
      return measureJobPage(env, job.kind, async () => {
        const identity = parseInstanceIdentity(env);
        if (identity.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        const page = await rotateActorKeysPage(env, identity.value, job);
        if (page.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        if (page.value.next !== undefined) {
          await env.OUTBOX_PROCESS_QUEUE.send(page.value.next, {
            delaySeconds: ROTATE_ACTOR_KEYS_PAUSE_SECONDS,
          });
        }
        return {
          outcome: "ok",
          size: page.value.rotated,
          chained: page.value.next !== undefined,
        };
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
      if (await publishDueScheduledStatuses(env)) {
        try {
          await env.OUTBOX_PROCESS_QUEUE.send(job);
        } catch {
          // The next cron run publishes the rest.
          console.error(JSON.stringify({ kind: "PublishScheduledStatusesNotChained" }));
        }
      }
      return "ok";
    case "ProcessLinkCard":
      return processLinkCardJob(env, job);
    case "FinishRemoteNoteRecipient":
      return processFinishRemoteNoteRecipientJob(env, job);
    case "NotifyRemoteNoteFollowers":
      return processNotifyRemoteNoteFollowersJob(env, job);
    case "NotifyLocalNoteFollowers":
      return processNotifyLocalNoteFollowersJob(env, job);
    case "NotifyRemoteNoteBoosters":
    case "NotifyLocalNoteBoosters":
      return processNotifyNoteBoostersJob(env, job);
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
    case "AuthorizeFollowRequests":
      return processAuthorizeFollowRequestsJob(env, job);
    case "SeverSuspendedActorFollows":
      return processSeverSuspendedActorFollowsJob(env, job);
    case "ResumeSuspendedActorSeverances":
      return processResumeSuspendedActorSeverancesJob(env);
    case "RefreshRemoteActor":
      return processRefreshRemoteActorJob(env, job);
    case "SendSeveranceNotices":
      return processSendSeveranceNoticesJob(env, job);
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
    case "ResolveRemoteThread":
      return processResolveRemoteThreadJob(env, job);
    case "RefetchAndVerifyQuote":
      return processRefetchAndVerifyQuoteJob(env, job);
    case "RefreshQuote":
      return processRefreshQuoteJob(env, job);
    case "FederatePendingStatuses":
      return processFederatePendingStatusesJob(env);
    case "VerifyProfileLinks":
      return processVerifyProfileLinksJob(env, job);
    case "SynchronizeFollowers":
      return processSynchronizeFollowersJob(env, job);
    case "ExpandFollowers": {
      const startedAt = Date.now();
      const activity = await findOutboundActivity(env.DB, job.activityId);
      if (activity.isErr()) {
        return "retry";
      }
      if (!activity.value) {
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
        pollStatusId === undefined ? ok([]) : await listPollInteractorInboxes(env.DB, pollStatusId);
      const reach =
        audience.accountReach && activity.value.account_id !== null
          ? await listAccountReachInboxes(env.DB, activity.value.account_id)
          : ok([]);
      logExpandLookupFailure(job.activityId, "followers", remoteFollowers);
      logExpandLookupFailure(job.activityId, "pollInteractors", interactors);
      logExpandLookupFailure(job.activityId, "accountReach", reach);
      const addressed = await findRemoteActorsByUris(env.DB, audience.actorUris);
      const candidateInboxes = [
        ...(remoteFollowers.isOk() ? remoteFollowers.value : []),
        ...(interactors.isOk() ? interactors.value : []),
        ...(reach.isOk() ? reach.value : []),
        ...(addressed.isOk() ? [...addressed.value.values()] : []).map(
          (actor) => actor.sharedInboxUri ?? actor.inboxUri,
        ),
      ];
      await deliverExpandedActivity(env, job.activityId, candidateInboxes, startedAt);
      return "ok";
    }
    case "ExpandForward":
      return processExpandForwardJob(env, job);
    case "DeliverTarget": {
      const target = await ensureOutboxTarget(env.DB, job.activityId, job.inboxUrl);
      if (target.isErr()) {
        return "ok";
      }
      await startOutboxDeliveryWorkflow(env, job.activityId);
      return "ok";
    }
    default:
      return assertNever(job);
  }
};
