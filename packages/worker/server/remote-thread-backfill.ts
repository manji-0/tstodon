import { type JobPage, measureJobPage } from "./metrics";
import {
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  RemoteActor,
  StatusId,
  type RemoteStatus,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
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
import {
  listCachedRemoteStatusUris,
  listRemoteThreadLevel,
  stampRemoteStatusRepliesFetched,
} from "./generated/prisma/sql";
import { nowInstant } from "./clock";
import { findRemoteStatusReplyTargetByObjectUri } from "./remote-reply-store";
import { refreshFetchedNote } from "./remote-update";
import { storeFetchedNote, storeNoteDocument } from "./remote-status-persist";
import { queueRemoteThreadResolve, threadResolveExhausted } from "./remote-thread-resolve";
import {
  claimRemoteThreadBackfill,
  findRemoteStatusById,
  findRemoteThreadRefresh,
  finishRemoteThreadBackfill,
  releaseRemoteThreadBackfill,
  type ThreadRefreshRecord,
} from "./remote-status-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { queryTyped, runTyped } from "./typed-sql";
import { instanceActorFetchSigner } from "./instance-actor";

/**
 * How long a status's `replies` count as read, Mastodon's
 * `FETCH_REPLIES_COOLDOWN_MINUTES`: opening the status fetches its thread
 * again only after this, and the tree walk skips a cached reply whose
 * `replies` it read within it (`replies_fetched_at`).
 */
export const THREAD_REPLIES_COOLDOWN_MS = 15 * 60 * 1000;

/** How long a fetched thread counts as fresh before opening the status fetches it again. */
export const THREAD_BACKFILL_TTL_MS = THREAD_REPLIES_COOLDOWN_MS;

/**
 * How long after it was published a status's `replies` are left unread,
 * Mastodon's `FETCH_REPLIES_INITIAL_WAIT_MINUTES` (its `created_at` of a
 * remote status is the note's `published`): opening a younger status queues
 * no walk, and the walk leaves out a younger reply it had before it started
 * (`created_recently`).
 */
export const THREAD_REPLIES_INITIAL_WAIT_MS = 5 * 60 * 1000;

/**
 * Notes fetched above the opened status. Each can cost a fetch, and an
 * author's actor when it is new, so this bounds the job's subrequests;
 * `CONTEXT_ANCESTOR_LIMIT` is how far a reader walks up anyway.
 */
export const THREAD_BACKFILL_ANCESTOR_LIMIT = 5;

/**
 * Pages of a `replies` collection are read until they hold this many
 * replies, as Mastodon's `collection_items` reads them with `max_items`
 * `FetchRepliesService::MAX_REPLIES` (`FetchAllRepliesService#call` is the
 * parent's, so the constant resolves to the parent's 5). Mastodon's own
 * first page holds the author's replies only, and the page its `next`
 * links every other account's (`?only_other_accounts=true&page=true`).
 */
export const THREAD_COLLECTION_PAGE_ITEMS = 5;

/** Replies kept of what one collection listed, `FetchAllRepliesService::MAX_REPLIES`. */
export const THREAD_COLLECTION_REPLY_LIMIT = 500;

/**
 * Pages of one collection read in one job. Mastodon reads a collection until
 * its pages hold {@link THREAD_COLLECTION_PAGE_ITEMS} replies or the tree
 * read {@link THREAD_TREE_PAGE_LIMIT} pages; a collection with more pages
 * than this to read goes on in the next job, at the page this one reached,
 * so that a job's subrequests stay bounded.
 */
export const THREAD_COLLECTION_PAGE_LIMIT = 10;

/**
 * Replies not cached yet that one job fetches. A list with more goes on in
 * the next job, where the job stopped in it.
 *
 * What bounds a job's subrequests. Each ActivityPub GET is up to four
 * requests, one plus three same-origin redirects, and may cost a DNS lookup
 * for the SSRF guard. A stored note costs its document and, for an author not
 * cached, that actor's at most thirteen requests (`remote-actor-refresh.ts`):
 * 20 notes are at most 20 × (4 + 13) = 340, and the first job's 5 ancestors
 * 85 more. Each status a job expands ({@link THREAD_TREE_NODES_PER_JOB}) costs
 * up to 12 GETs: its document, its `replies` collection when that is a link,
 * and up to {@link THREAD_COLLECTION_PAGE_LIMIT} pages, its `first` among
 * them, all read again when a job resumes inside its list; 5 of them are at
 * most 240 requests. Refreshing a status the walk had before it started can
 * fetch the note it quotes and that note's author, at most 17 more each, 85
 * in all. About 760 requests and their DNS lookups stay inside the 10,000
 * subrequests of a Workers Paid invocation this server is sized for, not the
 * Free plan's 50.
 */
export const THREAD_BACKFILL_REPLY_LIMIT = 20;

/**
 * Replies listed in a whole reply tree, as Mastodon's
 * `FetchAllRepliesWorker::MAX_REPLIES`: the walk stops once the `replies`
 * collections it read listed this many, cached or not.
 */
export const THREAD_TREE_REPLY_LIMIT = 1000;

/** `replies` pages read in a whole reply tree, as `FetchAllRepliesWorker::MAX_PAGES`. */
export const THREAD_TREE_PAGE_LIMIT = 500;

/**
 * Statuses of a tree the walk reaches, expanded or skipped, as Mastodon's
 * `fetched_uris` stops `FetchAllRepliesWorker` at `MAX_REPLIES`. With the
 * depth cap below it bounds the jobs of a walk however the tree is shaped.
 */
export const THREAD_TREE_NODE_LIMIT = THREAD_TREE_REPLY_LIMIT;

/** Levels below the opened status the walk goes down. */
export const THREAD_TREE_DEPTH_LIMIT = 100;

/**
 * Statuses expanded by one job of the tree walk, each by its document and
 * its `replies` pages. A job also stops once it fetched
 * {@link THREAD_BACKFILL_REPLY_LIMIT} replies, and the next job goes on where
 * it stopped.
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
 * was queued within the TTL, as Mastodon's `should_fetch_replies?`: only
 * public and unlisted statuses, whose origin serves them to anyone, and only
 * once the status is {@link THREAD_REPLIES_INITIAL_WAIT_MS} old. A younger
 * status queues the thread job of its parent instead
 * ({@link queueRemoteThreadResolve}), which Mastodon queued when it stored
 * the status (`Create#resolve_thread`) and tstodon did not for a note it
 * stored under another, such as a quoted note. Best effort and off the
 * request path: the thread renders what is cached, and the refresh this
 * resolves to tells a client when to read it again.
 */
export const requestRemoteThreadBackfill = async (
  env: Env,
  status: RemoteStatus,
): Promise<ThreadRefresh | undefined> => {
  if (status.visibility.kind !== "Public" && status.visibility.kind !== "Unlisted") {
    return undefined;
  }
  if (publishedRecently(status.publishedAt, Date.now())) {
    const identity = parseInstanceIdentity(env);
    if (identity.isOk()) {
      await queueRemoteThreadResolve(env, identity.value, status.id, 1);
    }
    return (await findThreadRefresh(env.DB, status.id)).unwrapOr(undefined);
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
 * the limit, each fetched from its URI and stored under an author on that
 * host. Resolves to how many it stored.
 *
 * The walk is one chain of parents, as a thread job's
 * ({@link queueRemoteThreadResolve}): the notes it stores queue no job of
 * their own, and when it stops at its limit below a parent not stored, the
 * topmost note's job goes on at the hop past the notes the walk stored. It
 * stops below a reply whose chain reached the hop limit, which nothing
 * starts again.
 */
const backfillAncestors = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatus,
  options: FederatedFetchOptions,
): Promise<number> => {
  const own = await findRemoteStatusReplyTargetByObjectUri(env.DB, status.objectUri);
  let parentUri = own.isOk() ? own.value?.inReplyToUri : undefined;
  let child: Readonly<{ id: string; objectUri: string }> = status;
  let stored = 0;
  for (let step = 0; step < THREAD_BACKFILL_ANCESTOR_LIMIT && parentUri; step += 1) {
    if (parseLocalStatusId(identity, parentUri)) {
      return stored;
    }
    let parent = await findRemoteStatusReplyTargetByObjectUri(env.DB, parentUri);
    if (parent.isOk() && !parent.value) {
      const exhausted = await threadResolveExhausted(env.DB, child.objectUri);
      if (exhausted.isErr() || exhausted.value) {
        return stored;
      }
      const persisted = await storeFetchedNote(env, identity, parentUri, {
        ...options,
        idClock: "Published",
        thread: { kind: "Skip" },
        fanOut: "Queued",
      });
      if (persisted.isErr() || !persisted.value) {
        return stored;
      }
      stored += 1;
      parent = await findRemoteStatusReplyTargetByObjectUri(env.DB, parentUri);
    }
    if (parent.isErr() || !parent.value) {
      return stored;
    }
    child = { id: parent.value.id, objectUri: parent.value.objectUri };
    parentUri = parent.value.inReplyToUri;
  }
  if (parentUri !== undefined) {
    // Best effort: the walk's notes are stored, and a reply whose job is not
    // queued gets its parent when the thread is opened again.
    await queueRemoteThreadResolve(env, identity, child.id, stored + 1);
  }
  return stored;
};

type LevelFrom = Extract<BackfillRemoteThread["from"], { kind: "Level" }>;

/** Where reading a note's `replies` starts: its document, or a page an earlier job reached. */
type ListReading = NonNullable<LevelFrom["resume"]>["reading"];

/**
 * What one read of a note's `replies` found: the items listed, the pages as
 * Mastodon's `collection_items` counts them, the note's document when the
 * read started there, and the page the next job reads on from when this one
 * stopped after {@link THREAD_COLLECTION_PAGE_LIMIT} pages.
 */
type ListedReplies = Readonly<{
  items: ReadonlyArray<unknown>;
  pages: number;
  document: unknown;
  rest: string | undefined;
}>;

/**
 * The replies the note at `objectUri` lists, read from where `reading`
 * starts, as Mastodon's `collection_items` with `max_pages`: the items of
 * the pages of its `replies`, read until they hold
 * {@link THREAD_COLLECTION_PAGE_ITEMS}, `treePages` were read or the list
 * ends, up to {@link THREAD_COLLECTION_REPLY_LIMIT}. A list that ends counts
 * one page more than was read, as `collection_items` counts the page it
 * found missing. After {@link THREAD_COLLECTION_PAGE_LIMIT} pages the read
 * stops short of the next page (`rest`). The collection, its `first` page
 * and each `next` page are read only from the note's own origin, as
 * Mastodon's `fetch_collection_page` checks each link against
 * `reference_uri`. `Unavailable` when the note's document or a page after
 * the first did not answer: the list would be cut short, and a later try may
 * read it whole.
 */
const listedReplies = async (
  identity: InstanceIdentity,
  objectUri: string,
  reading: ListReading,
  treePages: number,
  options: FederatedFetchOptions,
): Promise<ListedReplies | "Unavailable"> => {
  const origin = URL.parse(objectUri)?.origin;
  const pageReading = { itemLimit: THREAD_COLLECTION_REPLY_LIMIT, origin: origin ?? "" };
  let document: unknown;
  let page;
  if (reading.kind === "Page") {
    page =
      URL.parse(reading.uri)?.origin === origin
        ? await readCollectionPage(identity, reading.uri, options, pageReading)
        : undefined;
    if (page === "Unavailable") {
      return "Unavailable";
    }
  } else {
    const raw = await fetchActivityJson(identity, objectUri, options);
    if (raw.isErr() && raw.error.kind === "VerificationUnavailable") {
      return "Unavailable";
    }
    document = raw.isOk() ? raw.value : undefined;
    const holder = raw.isOk() ? parseRepliesHolder(raw.value) : undefined;
    const replies = holder?.isOk() ? holder.value.replies : undefined;
    if (typeof replies === "string") {
      page =
        URL.parse(replies)?.origin === origin
          ? await firstCollectionPage(identity, replies, options, pageReading)
          : undefined;
    } else {
      const collection = replies === undefined ? undefined : parseCollection(replies);
      page = collection?.isOk()
        ? await firstPageOf(identity, collection.value, objectUri, options, pageReading)
        : undefined;
    }
    if (page === undefined) {
      // No list: `collection_items` answers nothing, and no page counts.
      return { items: [], pages: 0, document, rest: undefined };
    }
  }
  const itemsBefore = reading.kind === "Page" ? reading.itemsBefore : 0;
  const items: unknown[] = [];
  let pages = 0;
  let rest: string | undefined;
  let ended = true;
  for (; page !== undefined;) {
    pages += 1;
    items.push(...page.items);
    if (itemsBefore + items.length >= THREAD_COLLECTION_PAGE_ITEMS || pages >= treePages) {
      ended = false;
      break;
    }
    const next = page.next;
    if (next === undefined || URL.parse(next)?.origin !== origin) {
      break;
    }
    if (pages >= THREAD_COLLECTION_PAGE_LIMIT) {
      rest = next;
      ended = false;
      break;
    }
    const following = await readCollectionPage(identity, next, options, pageReading);
    if (following === "Unavailable") {
      return "Unavailable";
    }
    page = following;
  }
  return {
    items: items.slice(0, THREAD_COLLECTION_REPLY_LIMIT),
    pages: ended ? pages + 1 : pages,
    document,
    rest,
  };
};

/** A reply a collection listed: its URI, and its object when the list embeds it. */
type ListedReply = Readonly<{ uri: string; embedded: Record<string, unknown> | undefined }>;

const listedReply = (item: unknown): ListedReply | undefined => {
  const reference = parseReplyReference(item);
  if (reference.isErr()) {
    return undefined;
  }
  return typeof reference.value === "string"
    ? { uri: reference.value, embedded: undefined }
    : { uri: reference.value.id, embedded: reference.value };
};

const CachedUriRow = z.object({ object_uri: z.string() });

/** Which of `uris` name a cached remote status, in one statement. */
const cachedStatusUris = (
  db: D1Database,
  uris: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(
    async () =>
      new Set(
        uris.length === 0
          ? []
          : (
              await queryTyped(db, listCachedRemoteStatusUris(jsonStringArray(uris)), CachedUriRow)
            ).map((row) => row.object_uri),
      ),
  );

/** What going through a listed slice of replies did: where it stopped, and the replies it stored. */
type StoredSlice = Readonly<{ next: number; fetched: number; stored: number }>;

/**
 * Store the replies `listed` holds from `offset` on that are neither local
 * nor cached, as Mastodon's `FetchReplyWorker` does, until `fetchBudget` of
 * them were fetched: no one vouches for a reply, so each is stored only
 * under an author on its URI's host. An embedded reply is read as it comes
 * only when its URI is on the origin that listed it; any other is fetched
 * from its URI. `next` is the offset to go on from, `listed.length` once
 * every reply was gone through.
 */
const storeListedReplies = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
  listed: ReadonlyArray<unknown>,
  offset: number,
  fetchBudget: number,
  options: FederatedFetchOptions,
): Promise<Result<StoredSlice, RepositoryError>> => {
  const replies = listed.map(listedReply);
  const cached = await cachedStatusUris(
    env.DB,
    replies.slice(offset).flatMap((reply) => (reply ? [reply.uri] : [])),
  );
  if (cached.isErr()) {
    return err(cached.error);
  }
  const replyOptions = {
    ...options,
    idClock: "Published",
    thread: { kind: "Skip" },
    fanOut: "Queued",
  } as const;
  const origin = URL.parse(objectUri)?.origin;
  let fetched = 0;
  let stored = 0;
  let index = offset;
  for (; index < replies.length && fetched < fetchBudget; index += 1) {
    const reply = replies[index];
    if (!reply || cached.value.has(reply.uri) || parseLocalStatusId(identity, reply.uri)) {
      continue;
    }
    fetched += 1;
    const persisted =
      reply.embedded !== undefined && URL.parse(reply.uri)?.origin === origin
        ? await storeNoteDocument(env, identity, reply.uri, reply.embedded, replyOptions)
        : await storeFetchedNote(env, identity, reply.uri, replyOptions);
    if (persisted.isOk() && persisted.value) {
      stored += 1;
    }
  }
  return ok({ next: index, fetched, stored });
};

const ThreadNodeRow = z.object({
  id: StatusId.schema,
  object_uri: z.string(),
  actor_uri: z.string(),
  published_at: z.string(),
  replies_fetched_at: z.string().nullable(),
  cached_before_walk: z.union([z.literal(0), z.literal(1)]),
});

type ThreadNode = z.infer<typeof ThreadNodeRow>;

/** One slice of a level of the reply tree below `rootId` ({@link listRemoteThreadLevel}). */
const listThreadLevel = (
  db: D1Database,
  rootId: string,
  from: LevelFrom,
  limit: number,
): Promise<Result<ReadonlyArray<ThreadNode>, RepositoryError>> =>
  runD1(() =>
    queryTyped(
      db,
      listRemoteThreadLevel(rootId, from.depth, from.after, limit, from.startedAt),
      ThreadNodeRow,
    ),
  );

export const processBackfillRemoteThreadJob = (
  env: Env,
  job: BackfillRemoteThread,
): Promise<"ok" | "retry"> => measureJobPage(env, job.kind, () => backfillRemoteThread(env, job));

/** Where a pass of the walk leaves the tree. */
type ThreadStep =
  | Readonly<{ kind: "Retry" }>
  | Readonly<{ kind: "Finished"; stored: number }>
  | Readonly<{ kind: "Continue"; from: LevelFrom }>;

/**
 * The walk of a remote status's reply tree, as Mastodon's
 * `FetchAllRepliesWorker`, spread over queued jobs: the first pass stores the
 * notes above the status and the replies it lists, and each later job expands
 * a few cached replies of one level of the tree by their own `replies`, a
 * level at a time, until a level has none or the tree has listed
 * {@link THREAD_TREE_REPLY_LIMIT} replies or read {@link THREAD_TREE_PAGE_LIMIT}
 * pages. Only the last job closes the claim, with the statuses stored, so the
 * async refresh reads as running until then. A first pass that cannot read
 * the status's list whole, or a job that cannot queue the next, is retried and
 * leaves the claim running; a reply deeper down whose list does not answer is
 * skipped.
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
    const startedAt = nowInstant();
    const ancestors = await backfillAncestors(env, identity.value, status.value, options);
    return expandLevel(
      env,
      identity.value,
      job.statusId,
      {
        kind: "Level",
        startedAt,
        depth: 0,
        after: "",
        visited: 0,
        listed: 0,
        pages: 0,
        stored: ancestors,
      },
      options,
    );
  }
  return expandLevel(env, identity.value, job.statusId, job.from, options);
};

/** `from` without the list a job stopped in, for a job that starts elsewhere. */
const withoutResume = ({ resume: _resume, ...from }: LevelFrom) => from;

/** Whether the walk reached one of the per-tree caps. */
const treeDone = (visited: number, listed: number, pages: number): boolean =>
  visited >= THREAD_TREE_NODE_LIMIT ||
  listed >= THREAD_TREE_REPLY_LIMIT ||
  pages >= THREAD_TREE_PAGE_LIMIT;

/** Whether the walk read a status's `replies` within the cooldown, as Mastodon's `fetched_recently`. */
const repliesFetchedRecently = (fetchedAt: string | null, now: number): boolean =>
  fetchedAt !== null && Date.parse(fetchedAt) > now - THREAD_REPLIES_COOLDOWN_MS;

/** Whether a status was published within the initial wait, as Mastodon's `created_recently`. */
const publishedRecently = (publishedAt: string, now: number): boolean =>
  Date.parse(publishedAt) > now - THREAD_REPLIES_INITIAL_WAIT_MS;

/**
 * Whether the walk had the status before it started: the opened status, or
 * a reply cached before. Mastodon's `FetchAllRepliesService` keeps such a
 * listed status only when it `should_fetch_replies`, touches its
 * `fetched_replies_at` and fetches it again (`FetchReplyWorker`); a reply the
 * walk stored is new to it, and expanded as it is.
 */
const hadBeforeWalk = (node: ThreadNode, depth: number): boolean =>
  depth === 0 || node.cached_before_walk === 1;

/**
 * Whether the walk leaves out a status it reached, as Mastodon's
 * `should_not_fetch_replies`: one it had before, whose `replies` were read
 * within the cooldown or, below the opened status, that was published within
 * the initial wait (the opened status's age is checked when it is opened).
 */
const leftOut = (node: ThreadNode, depth: number, now: number): boolean =>
  hadBeforeWalk(node, depth) &&
  (repliesFetchedRecently(node.replies_fetched_at, now) ||
    (depth > 0 && publishedRecently(node.published_at, now)));

/**
 * Apply the document the walk fetched for a status it had before to the
 * cached note, as Mastodon's `FetchReplyWorker` fetches each such status
 * again (`refreshFetchedNote`). Best effort, as that worker is a job of its
 * own: a refresh that fails leaves the note as cached.
 */
const refreshNode = async (
  env: Env,
  identity: InstanceIdentity,
  node: ThreadNode,
  document: unknown,
  options: FederatedFetchOptions,
): Promise<void> => {
  const author = await findRemoteActorByUri(env.DB, node.actor_uri);
  if (author.isOk() && author.value !== undefined) {
    await refreshFetchedNote(env, identity, author.value, node.object_uri, document, {
      ...options,
      fanOut: "Queued",
    });
  }
};

/**
 * Expand the next statuses of one level of the tree (depth 0 is the opened
 * status), up to {@link THREAD_TREE_NODES_PER_JOB} of them or until this job
 * fetched {@link THREAD_BACKFILL_REPLY_LIMIT} replies. A status the walk had
 * before it started ({@link hadBeforeWalk}) is left out as {@link leftOut}
 * says; any other is refreshed from the document its expansion reads and
 * recorded as read (`replies_fetched_at`). The walk goes on inside the list it
 * stopped in, at the page it reached in it, at the next status of the level,
 * or at the next level once this one is done. The opened status's list not
 * answering retries the job; a reply deeper down whose list does not answer
 * is skipped, as Mastodon's `FetchAllRepliesWorker` skips a failed fetch, so
 * one host down does not hold up the rest of the tree. A list's replies and
 * pages count toward the tree's caps once each of its replies was gone
 * through.
 */
const expandLevel = async (
  env: Env,
  identity: InstanceIdentity,
  rootId: string,
  from: LevelFrom,
  options: FederatedFetchOptions,
): Promise<ThreadStep> => {
  const nodes = await listThreadLevel(env.DB, rootId, from, THREAD_TREE_NODES_PER_JOB);
  if (nodes.isErr()) {
    return { kind: "Retry" };
  }
  if (nodes.value.length === 0) {
    // A level read to its end in full slices goes on to the next level; an
    // empty level ends the walk.
    return from.after === "" || from.depth >= THREAD_TREE_DEPTH_LIMIT
      ? { kind: "Finished", stored: from.stored }
      : { kind: "Continue", from: { ...withoutResume(from), depth: from.depth + 1, after: "" } };
  }
  const levelDoneAt = (last: string): boolean =>
    last === nodes.value.at(-1)?.id && nodes.value.length < THREAD_TREE_NODES_PER_JOB;
  const now = Date.now();
  let { after, visited, listed, pages, stored } = from;
  let fetched = 0;
  for (const node of nodes.value) {
    if (treeDone(visited, listed, pages) || fetched >= THREAD_BACKFILL_REPLY_LIMIT) {
      break;
    }
    const resumed = from.resume?.id === node.id ? from.resume : undefined;
    if (resumed === undefined) {
      visited += 1;
      if (leftOut(node, from.depth, now)) {
        // An opened status read so is not walked, as `should_fetch_replies?`.
        if (from.depth === 0) {
          return { kind: "Finished", stored };
        }
        after = node.id;
        continue;
      }
    }
    const reading = resumed?.reading ?? { kind: "Note" };
    const list = await listedReplies(
      identity,
      node.object_uri,
      reading,
      THREAD_TREE_PAGE_LIMIT - pages,
      options,
    );
    if (list === "Unavailable") {
      if (from.depth === 0) {
        // Retried, with the claim left running: finishing here would keep a
        // thread cut short by an outage for the whole cooldown.
        return { kind: "Retry" };
      }
    } else {
      if (resumed === undefined && hadBeforeWalk(node, from.depth)) {
        await refreshNode(env, identity, node, list.document, options);
      }
      const slice = await storeListedReplies(
        env,
        identity,
        node.object_uri,
        list.items,
        resumed?.offset ?? 0,
        THREAD_BACKFILL_REPLY_LIMIT - fetched,
        options,
      );
      if (slice.isErr()) {
        return { kind: "Retry" };
      }
      fetched += slice.value.fetched;
      stored += slice.value.stored;
      if (slice.value.next < list.items.length) {
        return {
          kind: "Continue",
          from: {
            ...from,
            after,
            resume: { id: node.id, reading, offset: slice.value.next },
            visited,
            listed,
            pages,
            stored,
          },
        };
      }
      listed += list.items.length;
      pages += list.pages;
      if (list.rest !== undefined && !treeDone(visited, listed, pages)) {
        const itemsBefore = reading.kind === "Page" ? reading.itemsBefore : 0;
        return {
          kind: "Continue",
          from: {
            ...from,
            after,
            resume: {
              id: node.id,
              reading: {
                kind: "Page",
                uri: list.rest,
                itemsBefore: itemsBefore + list.items.length,
              },
              offset: 0,
            },
            visited,
            listed,
            pages,
            stored,
          },
        };
      }
    }
    if (hadBeforeWalk(node, from.depth)) {
      await stampRepliesFetched(env.DB, node.id, now);
    }
    after = node.id;
  }
  if (
    treeDone(visited, listed, pages) ||
    (levelDoneAt(after) && from.depth >= THREAD_TREE_DEPTH_LIMIT)
  ) {
    return { kind: "Finished", stored };
  }
  const levelDone = levelDoneAt(after);
  const next = { ...withoutResume(from), visited, listed, pages, stored };
  return {
    kind: "Continue",
    from: levelDone ? { ...next, depth: from.depth + 1, after: "" } : { ...next, after },
  };
};

/** Record that the walk read the status's `replies` at `now`; best effort. */
const stampRepliesFetched = async (db: D1Database, statusId: string, now: number) => {
  await runD1(() =>
    runTyped(db, stampRemoteStatusRepliesFetched(new Date(now).toISOString(), statusId)),
  );
};
