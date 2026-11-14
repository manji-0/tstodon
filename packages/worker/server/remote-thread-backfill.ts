import { type JobPage, measureJobPage } from "./metrics";
import {
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  RemoteActor,
  type RemoteStatus,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { parseLocalStatusId } from "./activitypub";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { findRemoteActorByUri } from "./remote-actor-store";
import {
  firstCollectionPage,
  firstPageOf,
  parseCollection,
  readCollectionPage,
} from "./remote-collection";
import { findRemoteStatusReplyTargetByObjectUri } from "./remote-reply-store";
import { persistAnnouncedObject } from "./remote-status-persist";
import {
  claimRemoteThreadBackfill,
  findRemoteStatusById,
  findRemoteThreadRefresh,
  finishRemoteThreadBackfill,
  releaseRemoteThreadBackfill,
  type ThreadRefreshRecord,
} from "./remote-status-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { instanceActorFetchSigner } from "./instance-actor";

/** How long a fetched thread counts as fresh before opening the status fetches it again. */
export const THREAD_BACKFILL_TTL_MS = 60 * 60 * 1000;

/**
 * Notes fetched above the opened status. Each can cost a fetch, and an
 * author's actor when it is new, so this bounds the job's subrequests;
 * `CONTEXT_ANCESTOR_LIMIT` is how far a reader walks up anyway.
 */
export const THREAD_BACKFILL_ANCESTOR_LIMIT = 5;

/** Replies stored from the status's `replies` collection. */
export const THREAD_BACKFILL_REPLY_LIMIT = 20;

/**
 * Pages of `replies` read, the first one included. Mastodon's first page
 * holds the author's own replies only; every other account's are on the
 * pages its `next` links (`?only_other_accounts=true&page=true`).
 *
 * With the two limits above this bounds one job's fetches. A stored note
 * costs its document and, for an author not cached, that actor's at most
 * thirteen requests (`remote-actor-refresh.ts`): 5 ancestors and 20 replies
 * are at most 350, and the status's document and these pages 4 more. That is
 * inside the Workers Paid limit this server is sized for, not the Free
 * plan's 50, which the ancestors alone can pass.
 */
export const THREAD_BACKFILL_REPLY_PAGES = 3;

/**
 * How long a claimed fetch counts as running when its job never closed it (it
 * failed every retry). After that it reads as finished, so clients stop polling.
 */
export const THREAD_REFRESH_RUNNING_LIMIT_MS = 2 * 60 * 1000;

type BackfillRemoteThread = Extract<OutboxJobValue, { kind: "BackfillRemoteThread" }>;

/** A thread fetch as Mastodon's async refresh reports it. */
export type ThreadRefresh =
  | Readonly<{ kind: "Running" }>
  | Readonly<{ kind: "Finished"; resultCount: number }>;

/** The refresh a status's fetch record describes; undefined when it was never claimed. */
export const threadRefreshOf = (
  record: ThreadRefreshRecord,
  now: number,
): ThreadRefresh | undefined => {
  if (record.claimedAt === null) {
    return undefined;
  }
  if (record.finishedClaim === record.claimedAt) {
    return { kind: "Finished", resultCount: record.resultCount ?? 0 };
  }
  return Date.parse(record.claimedAt) < now - THREAD_REFRESH_RUNNING_LIMIT_MS
    ? { kind: "Finished", resultCount: 0 }
    : { kind: "Running" };
};

/** The current refresh of a remote status's thread, if one was ever claimed. */
export const findThreadRefresh = async (
  db: D1Database,
  statusId: string,
): Promise<Result<ThreadRefresh | undefined, RepositoryError>> =>
  (await findRemoteThreadRefresh(db, statusId)).map((record) =>
    record ? threadRefreshOf(record, Date.now()) : undefined,
  );

/**
 * Queue fetching the thread of a remote status the reader opened, unless one
 * was queued within the TTL. Only public and unlisted statuses, whose origin
 * serves them to anyone. Best effort and off the request path: the thread
 * renders what is cached, and the refresh this resolves to tells a client
 * when to read it again.
 */
export const requestRemoteThreadBackfill = async (
  env: Env,
  status: RemoteStatus,
): Promise<ThreadRefresh | undefined> => {
  if (status.visibility.kind !== "Public" && status.visibility.kind !== "Unlisted") {
    return undefined;
  }
  const claimed = await claimRemoteThreadBackfill(env.DB, status.id, THREAD_BACKFILL_TTL_MS);
  if (claimed.isErr()) {
    return undefined;
  }
  if (claimed.value === undefined) {
    return (await findThreadRefresh(env.DB, status.id)).unwrapOr(undefined);
  }
  const job = OutboxJob.parse({ kind: "BackfillRemoteThread", statusId: status.id });
  if (job.isErr()) {
    return undefined;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value);
    return { kind: "Running" };
  } catch {
    console.error(JSON.stringify({ kind: "ThreadBackfillNotQueued", statusId: status.id }));
    await releaseRemoteThreadBackfill(env.DB, status.id, claimed.value);
    return undefined;
  }
};

const ReplyReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

const parseReplyReference = schemaResult(ReplyReferenceSchema);

const RepliesHolderSchema = z.object({ replies: z.unknown().optional() }).passthrough();

const parseRepliesHolder = schemaResult(RepliesHolderSchema);

/**
 * Store the notes above `status` that are not cached yet, nearest first, up to
 * the limit. Resolves to how many it stored.
 */
const backfillAncestors = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  status: RemoteStatus,
  options: FederatedFetchOptions,
): Promise<number> => {
  const own = await findRemoteStatusReplyTargetByObjectUri(env.DB, status.objectUri);
  let parentUri = own.isOk() ? own.value?.inReplyToUri : undefined;
  let stored = 0;
  for (let step = 0; step < THREAD_BACKFILL_ANCESTOR_LIMIT && parentUri; step += 1) {
    if (parseLocalStatusId(identity, parentUri)) {
      return stored;
    }
    let parent = await findRemoteStatusReplyTargetByObjectUri(env.DB, parentUri);
    if (parent.isOk() && !parent.value) {
      const persisted = await persistAnnouncedObject(env, identity, actor, parentUri, {
        ...options,
        idClock: "Published",
      });
      if (persisted.isErr() || !persisted.value) {
        return stored;
      }
      stored += 1;
      parent = await findRemoteStatusReplyTargetByObjectUri(env.DB, parentUri);
    }
    parentUri = parent.isOk() ? parent.value?.inReplyToUri : undefined;
  }
  return stored;
};

/**
 * The replies the status's origin lists: the items of the first pages of its
 * `replies`, up to the limits. A `next` link is followed only on the status's
 * own origin. `Unavailable` when the status's document or a page after the
 * first did not answer: the list would be cut short, and a later try may
 * read it whole.
 */
const listedReplies = async (
  identity: InstanceIdentity,
  status: RemoteStatus,
  options: FederatedFetchOptions,
): Promise<ReadonlyArray<unknown> | "Unavailable"> => {
  const raw = await fetchActivityJson(identity, status.objectUri, options);
  if (raw.isErr() && raw.error.kind === "VerificationUnavailable") {
    return "Unavailable";
  }
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
  const origin = URL.parse(status.objectUri)?.origin;
  const items: unknown[] = [];
  for (let pages = 1; page !== undefined; pages += 1) {
    items.push(...page.items);
    const next = page.next;
    if (
      next === undefined ||
      pages === THREAD_BACKFILL_REPLY_PAGES ||
      items.length >= THREAD_BACKFILL_REPLY_LIMIT ||
      URL.parse(next)?.origin !== origin
    ) {
      break;
    }
    const following = await readCollectionPage(identity, next, options);
    if (following === "Unavailable") {
      return "Unavailable";
    }
    page = following;
  }
  return items.slice(0, THREAD_BACKFILL_REPLY_LIMIT);
};

/**
 * Store the replies the status's origin lists ({@link listedReplies}).
 * Resolves to how many were not cached before, or `Unavailable` when the
 * list could not be read whole: nothing of it is stored then.
 */
const backfillReplies = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  status: RemoteStatus,
  options: FederatedFetchOptions,
): Promise<number | "Unavailable"> => {
  const listed = await listedReplies(identity, status, options);
  if (listed === "Unavailable") {
    return "Unavailable";
  }
  let stored = 0;
  for (const item of listed) {
    const reference = parseReplyReference(item);
    if (reference.isErr()) {
      continue;
    }
    const uri = typeof reference.value === "string" ? reference.value : reference.value.id;
    const cached = await findRemoteStatusReplyTargetByObjectUri(env.DB, uri);
    if (cached.isErr() || cached.value) {
      continue;
    }
    const persisted = await persistAnnouncedObject(env, identity, actor, reference.value, {
      ...options,
      idClock: "Published",
    });
    if (persisted.isOk() && persisted.value) {
      stored += 1;
    }
  }
  return stored;
};

export const processBackfillRemoteThreadJob = (
  env: Env,
  job: BackfillRemoteThread,
): Promise<"ok" | "retry"> => measureJobPage(env, job.kind, () => backfillRemoteThread(env, job));

/**
 * The job is one pass and never chains; `size` is not counted (0). Every `ok`
 * closes the claim, with the statuses stored, so the async refresh reads as
 * finished; a `retry` leaves it running.
 */
const backfillRemoteThread = async (env: Env, job: BackfillRemoteThread): Promise<JobPage> => {
  const stored = await backfillRemoteThreadPass(env, job);
  if (stored === undefined) {
    return { outcome: "retry", size: 0, chained: false };
  }
  await finishRemoteThreadBackfill(env.DB, job.statusId, stored);
  return { outcome: "ok", size: 0, chained: false };
};

/** How many statuses the pass stored, or undefined when it should be retried. */
const backfillRemoteThreadPass = async (
  env: Env,
  job: BackfillRemoteThread,
): Promise<number | undefined> => {
  const identity = parseInstanceIdentity(env);
  const status = await findRemoteStatusById(env.DB, job.statusId);
  if (identity.isErr() || status.isErr()) {
    return undefined;
  }
  if (!status.value) {
    return 0;
  }
  const actor = await findRemoteActorByUri(env.DB, status.value.actorUri);
  if (actor.isErr()) {
    return undefined;
  }
  const suspended = await suspendedDomains(env.DB);
  if (!actor.value || RemoteActor.onAnyHost(actor.value, suspended)) {
    return 0;
  }
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: suspended,
    fetchSigner: instanceActorFetchSigner(env.DB, identity.value),
  };
  const ancestors = await backfillAncestors(
    env,
    identity.value,
    actor.value,
    status.value,
    options,
  );
  const replies = await backfillReplies(env, identity.value, actor.value, status.value, options);
  // Retried, with the claim left running: finishing here would keep a thread
  // cut short by an outage for the whole TTL. What a try stored stays.
  return replies === "Unavailable" ? undefined : ancestors + replies;
};
