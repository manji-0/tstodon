import { assertNever } from "@tstodon/core";
import {
  Hostname,
  OutboxJob,
  StoredMediaMetadata,
  StoredMediaSizes,
  type OutboxJob as OutboxJobValue,
} from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
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
import { vacuumMediaAttachments } from "./media-vacuum";
import { vacuumActivities } from "./activity-vacuum";
import { requeueDeadOutboxJobs } from "./dead-letter-queue";
import { ROTATE_ACTOR_KEYS_PAUSE_SECONDS, rotateActorKeysPage } from "./actor-key-rotation";
import {
  logStripStoredMediaMetadataDone,
  stripStoredMediaMetadataPage,
} from "./media-metadata-backfill";
import { backfillStoredMediaSizesPage, logBackfillStoredMediaSizesDone } from "./media-sizes";
import { backfillLocalNoteTags } from "./local-tag-backfill";
import { foldTagNames } from "./tag-name-fold";
import { publishDueScheduledStatuses } from "./scheduled-status-publish";
import { cleanUpAccountStatuses, queueStatusesCleanup } from "./statuses-cleanup";
import { findRemoteActorsByUris, listAcceptedRemoteFollowerInboxes } from "./remote-actor-store";
import {
  allowListAdmits,
  federationAllowHosts,
  legacyMediaPolicy,
  parseInstanceIdentity,
} from "./runtime-config";
import {
  partitionByDomainAvailability,
  recordSkippedTargets,
  startOutboxDeliveryWorkflow,
} from "./delivery";
import { parseJsonText } from "./json-column";
import { parseLocalStatusId } from "./activitypub";
import { listPollInteractorInboxes } from "./remote-interaction-store";
import { processRefetchAndVerifyQuoteJob, processRefreshQuoteJob } from "./quote-retry-jobs";

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

/** A failed recipient lookup leaves those recipients out; say so in the logs. */
const logExpandLookupFailure = (
  activityId: string,
  lookup: "followers" | "pollInteractors",
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
    case "RefreshLinkCards":
      await refreshStaleLinkCards(env);
      return "ok";
    case "BackfillRemoteTags":
      await indexMissingRemoteTags(env.DB);
      return "ok";
    case "BackfillLocalNoteTags":
      return measureJobPage(env, job.kind, async () => {
        const page = await backfillLocalNoteTags(env.DB);
        if (page.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        if (page.value.chained) {
          await env.OUTBOX_PROCESS_QUEUE.send({ kind: "BackfillLocalNoteTags" });
        }
        return { outcome: "ok", size: page.value.scanned, chained: page.value.chained };
      });
    case "FoldTagNames":
      return measureJobPage(env, job.kind, async () => {
        const page = await foldTagNames(env.DB);
        if (page.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
        if (page.value.chained) {
          await env.OUTBOX_PROCESS_QUEUE.send({ kind: "FoldTagNames" });
        }
        return { outcome: "ok", size: page.value.scanned, chained: page.value.chained };
      });
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
    case "StripStoredMediaMetadata":
      return measureJobPage(env, job.kind, async () => {
        const page = await stripStoredMediaMetadataPage(env, job);
        if (page.isErr()) {
          return { outcome: "retry", size: 0, chained: false, step: job.source };
        }
        const tally = StoredMediaMetadata.addTally(job.tally, page.value.tally);
        const { next } = page.value;
        if (next) {
          await env.OUTBOX_PROCESS_QUEUE.send({
            kind: "StripStoredMediaMetadata",
            source: next.source,
            afterId: next.afterId,
            tally,
          });
        } else if (Object.values(tally).some((n) => n > 0)) {
          // A run with nothing left to do (every later cron) logs nothing.
          logStripStoredMediaMetadataDone(tally);
        }
        return {
          outcome: "ok",
          size: page.value.scanned,
          chained: next !== undefined,
          step: job.source,
        };
      });
    case "BackfillStoredMediaSizes":
      return measureJobPage(env, job.kind, async () => {
        const page = await backfillStoredMediaSizesPage(env, job);
        if (page.isErr()) {
          return { outcome: "retry", size: 0, chained: false, step: job.source };
        }
        const tally = StoredMediaSizes.addTally(job.tally, page.value.tally);
        const { next } = page.value;
        if (next) {
          await env.OUTBOX_PROCESS_QUEUE.send({
            kind: "BackfillStoredMediaSizes",
            source: next.source,
            afterId: next.afterId,
            tally,
          });
        } else if (Object.values(tally).some((n) => n > 0)) {
          // A run with nothing left to do (every later cron) logs nothing.
          logBackfillStoredMediaSizesDone(tally);
        }
        return {
          outcome: "ok",
          size: page.value.scanned,
          chained: next !== undefined,
          step: job.source,
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
    case "RefetchAndVerifyQuote":
      return processRefetchAndVerifyQuoteJob(env, job);
    case "RefreshQuote":
      return processRefreshQuoteJob(env, job);
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
        pollStatusId === undefined ? ok([]) : await listPollInteractorInboxes(env.DB, pollStatusId);
      logExpandLookupFailure(job.activityId, "followers", remoteFollowers);
      logExpandLookupFailure(job.activityId, "pollInteractors", interactors);
      const addressed = await findRemoteActorsByUris(env.DB, audience.actorUris);
      const candidateInboxes = [
        ...(remoteFollowers.isOk() ? remoteFollowers.value : []),
        ...(interactors.isOk() ? interactors.value : []),
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
      // An inbox on a domain marked unavailable gets a `Skipped` target, not a Workflow.
      const { deliver, skipped } = await partitionByDomainAvailability(env.DB, remoteInboxes);
      const skippedTargets = await recordSkippedTargets(env, job.activityId, skipped, "expand");
      const ensured = skippedTargets.isErr()
        ? skippedTargets
        : await ensureOutboxTargets(env.DB, job.activityId, deliver);
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
      for (const inboxUrl of deliver) {
        const deliverJob = OutboxJob.parse({
          kind: "DeliverTarget",
          activityId: job.activityId,
          inboxUrl,
        });
        if (deliverJob.isErr() || deliverJob.value.kind !== "DeliverTarget") {
          continue;
        }
        await startOutboxDeliveryWorkflow(env, deliverJob.value);
      }
      // doubles: [remoteTargetCount, expandMs, okFlag, skippedCount]
      writeMetric(
        env,
        "outbox.expand",
        [remoteInboxes.length, elapsedMs(startedAt), 1, skipped.length],
        ["ok"],
      );
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
