import { type JobPage, measureJobPage } from "./metrics";
import { authorityHost } from "./domain-block-store";
import {
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  type RemoteActor,
  type RemoteStatus,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { parseLocalStatusId } from "./activitypub";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { findRemoteActorByUri } from "./remote-actor-store";
import { firstCollectionPage, firstPageOf, parseCollection } from "./remote-collection";
import { findRemoteStatusReplyTargetByObjectUri } from "./remote-reply-store";
import { persistAnnouncedObject } from "./remote-status-persist";
import {
  claimRemoteThreadBackfill,
  findRemoteStatusById,
  releaseRemoteThreadBackfill,
} from "./remote-status-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/** How long a fetched thread counts as fresh before opening the status fetches it again. */
export const THREAD_BACKFILL_TTL_MS = 60 * 60 * 1000;

/**
 * Notes fetched above the opened status. Each can cost a fetch, and an
 * author's actor when it is new, so this bounds the job's subrequests;
 * `CONTEXT_ANCESTOR_LIMIT` is how far a reader walks up anyway.
 */
export const THREAD_BACKFILL_ANCESTOR_LIMIT = 5;

/** Replies stored from the status's `replies` collection: its first page. */
export const THREAD_BACKFILL_REPLY_LIMIT = 20;

type BackfillRemoteThread = Extract<OutboxJobValue, { kind: "BackfillRemoteThread" }>;

/**
 * Queue fetching the thread of a remote status the reader opened, unless one
 * was queued within the TTL. Only public and unlisted statuses, whose origin
 * serves them to anyone. Best effort and off the request path: the thread
 * renders what is cached and shows the rest on the next view.
 */
export const requestRemoteThreadBackfill = async (
  env: Env,
  status: RemoteStatus,
): Promise<void> => {
  if (status.visibility.kind !== "Public" && status.visibility.kind !== "Unlisted") {
    return;
  }
  const claimed = await claimRemoteThreadBackfill(env.DB, status.id, THREAD_BACKFILL_TTL_MS);
  if (claimed.isErr() || claimed.value === undefined) {
    return;
  }
  const job = OutboxJob.parse({ kind: "BackfillRemoteThread", statusId: status.id });
  if (job.isErr()) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value);
  } catch {
    console.error(JSON.stringify({ kind: "ThreadBackfillNotQueued", statusId: status.id }));
    await releaseRemoteThreadBackfill(env.DB, status.id, claimed.value);
  }
};

const ReplyReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

const parseReplyReference = schemaResult(ReplyReferenceSchema);

const RepliesHolderSchema = z.object({ replies: z.unknown().optional() }).passthrough();

const parseRepliesHolder = schemaResult(RepliesHolderSchema);

/** Store the notes above `status` that are not cached yet, nearest first, up to the limit. */
const backfillAncestors = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  status: RemoteStatus,
  options: FederatedFetchOptions,
): Promise<void> => {
  const own = await findRemoteStatusReplyTargetByObjectUri(env.DB, status.objectUri);
  let parentUri = own.isOk() ? own.value?.inReplyToUri : undefined;
  for (let step = 0; step < THREAD_BACKFILL_ANCESTOR_LIMIT && parentUri; step += 1) {
    if (parseLocalStatusId(identity, parentUri)) {
      return;
    }
    let parent = await findRemoteStatusReplyTargetByObjectUri(env.DB, parentUri);
    if (parent.isOk() && !parent.value) {
      const stored = await persistAnnouncedObject(env, identity, actor, parentUri, {
        ...options,
        idClock: "Published",
      });
      if (stored.isErr() || !stored.value) {
        return;
      }
      parent = await findRemoteStatusReplyTargetByObjectUri(env.DB, parentUri);
    }
    parentUri = parent.isOk() ? parent.value?.inReplyToUri : undefined;
  }
};

/** Store the replies the status's origin lists, from the first page of its `replies`. */
const backfillReplies = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  status: RemoteStatus,
  options: FederatedFetchOptions,
): Promise<void> => {
  const raw = await fetchActivityJson(identity, status.objectUri, options);
  const holder = raw.isOk() ? parseRepliesHolder(raw.value) : undefined;
  const replies = holder?.isOk() ? holder.value.replies : undefined;
  let page;
  if (typeof replies === "string") {
    page = await firstCollectionPage(identity, replies, options);
  } else {
    const collection = replies === undefined ? undefined : parseCollection(replies);
    page = collection?.isOk()
      ? await firstPageOf(identity, collection.value, status.objectUri, options)
      : undefined;
  }
  for (const item of (page?.items ?? []).slice(0, THREAD_BACKFILL_REPLY_LIMIT)) {
    const reference = parseReplyReference(item);
    if (reference.isErr()) {
      continue;
    }
    await persistAnnouncedObject(env, identity, actor, reference.value, {
      ...options,
      idClock: "Published",
    });
  }
};

export const processBackfillRemoteThreadJob = (
  env: Env,
  job: BackfillRemoteThread,
): Promise<"ok" | "retry"> => measureJobPage(env, job.kind, () => backfillRemoteThread(env, job));

/** The job is one pass and never chains; `size` is not counted (0). */
const backfillRemoteThread = async (env: Env, job: BackfillRemoteThread): Promise<JobPage> => {
  const identity = parseInstanceIdentity(env);
  const status = await findRemoteStatusById(env.DB, job.statusId);
  if (identity.isErr() || status.isErr()) {
    return { outcome: "retry", size: 0, chained: false };
  }
  if (!status.value) {
    return { outcome: "ok", size: 0, chained: false };
  }
  const actor = await findRemoteActorByUri(env.DB, status.value.actorUri);
  if (actor.isErr()) {
    return { outcome: "retry", size: 0, chained: false };
  }
  const suspended = await suspendedDomains(env.DB);
  if (!actor.value || suspended.has(authorityHost(actor.value.domain))) {
    return { outcome: "ok", size: 0, chained: false };
  }
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: suspended,
  };
  await backfillAncestors(env, identity.value, actor.value, status.value, options);
  await backfillReplies(env, identity.value, actor.value, status.value, options);
  return { outcome: "ok", size: 0, chained: false };
};
