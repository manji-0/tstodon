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
import { type RepositoryError, runD1 } from "./d1";
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
import { listRemoteThreadLevel } from "./generated/prisma/sql";
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
import { queryTyped } from "./typed-sql";
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
 * Replies listed in a whole reply tree, as Mastodon's
 * `FetchAllRepliesWorker::MAX_REPLIES`: the walk stops once the `replies`
 * collections it read listed this many, cached or not.
 */
export const THREAD_TREE_REPLY_LIMIT = 1000;

/** `replies` pages read in a whole reply tree, as `FetchAllRepliesWorker::MAX_PAGES`. */
export const THREAD_TREE_PAGE_LIMIT = 500;

/**
 * Replies expanded by one job of the tree walk: each costs its document, its
 * `replies` pages and the replies it lists, so a job's fetches stay those of
 * the first pass ({@link THREAD_BACKFILL_REPLY_PAGES}). A job also stops once
 * it stored {@link THREAD_BACKFILL_REPLY_LIMIT} replies, and the next job
 * goes on where it stopped.
 */
export const THREAD_TREE_NODES_PER_JOB = 5;

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

/** The items a note's `replies` collection lists, and the pages read for them. */
type ListedReplies = Readonly<{ items: ReadonlyArray<unknown>; pages: number }>;

/**
 * The replies the note at `objectUri` lists: the items of the first pages of
 * its `replies`, up to the limits. The collection is read only on the note's
 * own origin, as Mastodon's `fetch_collection_page` checks with
 * `reference_uri`, and so is a `next` link. `Unavailable` when the note's
 * document or a page after the first did not answer: the list would be cut
 * short, and a later try may read it whole.
 */
const listedReplies = async (
  identity: InstanceIdentity,
  objectUri: string,
  options: FederatedFetchOptions,
): Promise<ListedReplies | "Unavailable"> => {
  const raw = await fetchActivityJson(identity, objectUri, options);
  if (raw.isErr() && raw.error.kind === "VerificationUnavailable") {
    return "Unavailable";
  }
  const origin = URL.parse(objectUri)?.origin;
  const holder = raw.isOk() ? parseRepliesHolder(raw.value) : undefined;
  const replies = holder?.isOk() ? holder.value.replies : undefined;
  let page;
  if (typeof replies === "string") {
    page =
      URL.parse(replies)?.origin === origin
        ? await firstCollectionPage(identity, replies, options)
        : undefined;
  } else {
    const collection = replies === undefined ? undefined : parseCollection(replies);
    page = collection?.isOk()
      ? await firstPageOf(identity, collection.value, objectUri, options)
      : undefined;
  }
  const items: unknown[] = [];
  let pages = 0;
  for (; page !== undefined;) {
    pages += 1;
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
  return { items: items.slice(0, THREAD_BACKFILL_REPLY_LIMIT), pages };
};

/** What expanding one note did: the replies its collection listed, the pages read, the replies stored. */
type Expanded = Readonly<{ listed: number; pages: number; stored: number }>;

/**
 * Store the replies the note at `objectUri` lists ({@link listedReplies}).
 * `Unavailable` when the list could not be read whole: nothing of it is
 * stored then.
 */
const backfillReplies = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  objectUri: string,
  options: FederatedFetchOptions,
): Promise<Expanded | "Unavailable"> => {
  const listed = await listedReplies(identity, objectUri, options);
  if (listed === "Unavailable") {
    return "Unavailable";
  }
  let stored = 0;
  for (const item of listed.items) {
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
  return { listed: listed.items.length, pages: listed.pages, stored };
};

const ThreadNodeRow = z.object({ id: z.string(), object_uri: z.string() });

/** One slice of a level of the reply tree below `rootId` ({@link listRemoteThreadLevel}). */
const listThreadLevel = (
  db: D1Database,
  rootId: string,
  depth: number,
  after: string,
  limit: number,
): Promise<Result<ReadonlyArray<z.infer<typeof ThreadNodeRow>>, RepositoryError>> =>
  runD1(() => queryTyped(db, listRemoteThreadLevel(rootId, depth, after, limit), ThreadNodeRow));

export const processBackfillRemoteThreadJob = (
  env: Env,
  job: BackfillRemoteThread,
): Promise<"ok" | "retry"> => measureJobPage(env, job.kind, () => backfillRemoteThread(env, job));

/** Where a pass of the walk leaves the tree. */
type ThreadStep =
  | Readonly<{ kind: "Retry" }>
  | Readonly<{ kind: "Finished"; stored: number }>
  | Readonly<{ kind: "Continue"; from: Extract<BackfillRemoteThread["from"], { kind: "Level" }> }>;

/**
 * The walk of a remote status's reply tree, as Mastodon's
 * `FetchAllRepliesWorker`, spread over queued jobs: the first pass stores the
 * notes above the status and the replies it lists, and each later job expands
 * a few cached replies of one level of the tree by their own `replies`, a
 * level at a time, until a level has none or the tree has listed
 * {@link THREAD_TREE_REPLY_LIMIT} replies or read {@link THREAD_TREE_PAGE_LIMIT}
 * pages. Only the last job closes the claim, with the statuses stored, so the
 * async refresh reads as running until then. A job that cannot read a list
 * whole, or cannot queue the next, is retried and leaves the claim running.
 */
const backfillRemoteThread = async (env: Env, job: BackfillRemoteThread): Promise<JobPage> => {
  const step = await backfillRemoteThreadPass(env, job);
  switch (step.kind) {
    case "Retry":
      return { outcome: "retry", size: 0, chained: false };
    case "Finished":
      await finishRemoteThreadBackfill(env.DB, job.statusId, step.stored);
      return { outcome: "ok", size: 0, chained: false };
    case "Continue":
      try {
        await env.OUTBOX_PROCESS_QUEUE.send({ ...job, from: step.from });
      } catch {
        console.error(JSON.stringify({ kind: "ThreadBackfillNotChained", statusId: job.statusId }));
        return { outcome: "retry", size: 0, chained: false };
      }
      return { outcome: "ok", size: 0, chained: true };
  }
};

/** What one job of the walk did ({@link backfillRemoteThread}). */
const backfillRemoteThreadPass = async (
  env: Env,
  job: BackfillRemoteThread,
): Promise<ThreadStep> => {
  const identity = parseInstanceIdentity(env);
  const status = await findRemoteStatusById(env.DB, job.statusId);
  if (identity.isErr() || status.isErr()) {
    return { kind: "Retry" };
  }
  if (!status.value) {
    return { kind: "Finished", stored: 0 };
  }
  const actor = await findRemoteActorByUri(env.DB, status.value.actorUri);
  if (actor.isErr()) {
    return { kind: "Retry" };
  }
  const suspended = await suspendedDomains(env.DB);
  if (!actor.value || RemoteActor.onAnyHost(actor.value, suspended)) {
    return { kind: "Finished", stored: 0 };
  }
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: suspended,
    fetchSigner: instanceActorFetchSigner(env.DB, identity.value),
  };
  if (job.from.kind === "Root") {
    const ancestors = await backfillAncestors(
      env,
      identity.value,
      actor.value,
      status.value,
      options,
    );
    const replies = await backfillReplies(
      env,
      identity.value,
      actor.value,
      status.value.objectUri,
      options,
    );
    // Retried, with the claim left running: finishing here would keep a thread
    // cut short by an outage for the whole TTL. What a try stored stays.
    if (replies === "Unavailable") {
      return { kind: "Retry" };
    }
    const stored = ancestors + replies.stored;
    return replies.listed === 0
      ? { kind: "Finished", stored }
      : {
          kind: "Continue",
          from: {
            kind: "Level",
            depth: 1,
            after: "",
            listed: replies.listed,
            pages: replies.pages,
            stored,
          },
        };
  }
  return expandLevel(env, identity.value, actor.value, job.statusId, job.from, options);
};

/**
 * Expand the next replies of one level of the tree, up to
 * {@link THREAD_TREE_NODES_PER_JOB} of them or until this job stored
 * {@link THREAD_BACKFILL_REPLY_LIMIT}. The walk goes on at the next of the
 * level, or at the next level once this one is done.
 */
const expandLevel = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  rootId: string,
  from: Extract<BackfillRemoteThread["from"], { kind: "Level" }>,
  options: FederatedFetchOptions,
): Promise<ThreadStep> => {
  const nodes = await listThreadLevel(
    env.DB,
    rootId,
    from.depth,
    from.after,
    THREAD_TREE_NODES_PER_JOB,
  );
  if (nodes.isErr()) {
    return { kind: "Retry" };
  }
  if (nodes.value.length === 0) {
    return { kind: "Finished", stored: from.stored };
  }
  let { after, listed, pages, stored } = from;
  let storedHere = 0;
  for (const node of nodes.value) {
    if (
      listed >= THREAD_TREE_REPLY_LIMIT ||
      pages >= THREAD_TREE_PAGE_LIMIT ||
      storedHere >= THREAD_BACKFILL_REPLY_LIMIT
    ) {
      break;
    }
    const expanded = await backfillReplies(env, identity, actor, node.object_uri, options);
    if (expanded === "Unavailable") {
      return { kind: "Retry" };
    }
    after = node.id;
    listed += expanded.listed;
    pages += expanded.pages;
    stored += expanded.stored;
    storedHere += expanded.stored;
  }
  if (listed >= THREAD_TREE_REPLY_LIMIT || pages >= THREAD_TREE_PAGE_LIMIT) {
    return { kind: "Finished", stored };
  }
  const levelDone =
    after === nodes.value.at(-1)?.id && nodes.value.length < THREAD_TREE_NODES_PER_JOB;
  return {
    kind: "Continue",
    from: levelDone
      ? { kind: "Level", depth: from.depth + 1, after: "", listed, pages, stored }
      : { kind: "Level", depth: from.depth, after, listed, pages, stored },
  };
};
