import { z } from "zod";
import {
  AccountId,
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  type RemovedBoost,
  StatusId,
  type StreamEventValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { signedInRecentlySince } from "./account-activity";
import { type RepositoryError, runD1 } from "./d1";
import { listHomeFanOutAccounts } from "./generated/prisma/sql";
import { type JobStart, startJob } from "./inline-job";
import { findListForAccount } from "./list-store";
import { type StreamRenderTally, measureJobPage, streamRenderTally } from "./metrics";
import { parseInstanceIdentity } from "./runtime-config";
import { queueOutboxJobs } from "./queue-jobs";
import { publishToAccount, publishToHub } from "./stream-publish";
import { listHubStreamSubscriptions, streamListeners } from "./stream-subscription-store";
import { homeTimelineDocuments, listTimelineDocuments } from "./timeline-documents";
import { queryTyped } from "./typed-sql";

const AccountIdRow = z.object({ account_id: AccountId.schema });

type FanOutHome = Extract<OutboxJobValue, { kind: "FanOutHome" }>;
type FanOutRemovedStatuses = Extract<OutboxJobValue, { kind: "FanOutRemovedStatuses" }>;

/** The event a fan-out tells and the home timeline entry it is about. */
type HomeEntryEvent = Pick<FanOutHome, "event" | "entryId">;

/**
 * Followers told per pass, of those with a `user` or `list` stream open. An
 * open `user` stream costs the entry's home timeline render for that
 * follower, about 28 statements (`pnpm bench`), and each list stream a
 * follower has open a list timeline query. A queue invocation runs up to
 * `maxBatchSize` (5) pages and may make 1,000 statements, so a page of 3
 * keeps a full batch under half of that (`home-fan-out-budget.test.ts`); a
 * page of 20 made 2,811.
 */
export const HOME_FAN_OUT_PAGE_SIZE = 3;

/**
 * Followers one `List` step lists. Listing reads every follower of the
 * author, however few it returns (`pnpm bench`'s celebrity: about 2,200 rows
 * for a page of 3, 11,900 for all 400), so it is done once for this many and
 * not once per page; 600 is 200 page jobs, two `sendBatch` calls.
 */
export const HOME_FAN_OUT_LIST_SIZE = 600;

/**
 * Tell the author's local followers about a home timeline entry, as
 * Mastodon's `FanOutOnWriteService` and `RemoveStatusService` do for the
 * `user` and `list` streams. Nothing is done when no hub holds a `user` or
 * `list` stream (one cached read); otherwise the first page of followers is
 * told once the response is ready, or by the queue when `start` is
 * `Queued`, and the queue takes later pages and a page to retry.
 * Best effort: the entry is stored either way, and a follower who misses the
 * event still sees the entry on the next home timeline fetch.
 */
export const startHomeFanOut = async (
  env: Env,
  fanOut: Readonly<{
    event: FanOutHome["event"];
    entryId: string;
    author:
      | Readonly<{ kind: "LocalAccount"; accountId: string }>
      | Readonly<{ kind: "RemoteActor"; actorUri: string }>;
  }>,
  start: JobStart = "Inline",
): Promise<void> => {
  const job = OutboxJob.parse({
    kind: "FanOutHome",
    ...fanOut,
    step: { kind: "List", afterAccountId: "" },
  });
  if (job.isErr() || job.value.kind !== "FanOutHome") {
    return;
  }
  if (!(await streamListeners(env.DB)).home) {
    return;
  }
  await startJob(env, job.value, processFanOutHomeJob, start);
};

/**
 * Tell the boosters and their followers that boosts are gone, as for any
 * status their account deletes: the booster's own streams, and the home and
 * list streams of its followers.
 */
export const announceRemovedBoosts = async (
  env: Env,
  boosts: ReadonlyArray<RemovedBoost>,
): Promise<void> => {
  for (const boost of boosts) {
    const statusId = StatusId.parse(boost.id);
    if (statusId.isOk()) {
      try {
        await publishToAccount(env, boost.accountId, { kind: "delete", statusId: statusId.value });
      } catch {
        console.error(JSON.stringify({ kind: "BoostRemovalNotPublished", entryId: boost.id }));
      }
    }
    await startHomeFanOut(env, {
      event: "delete",
      entryId: boost.id,
      author: { kind: "LocalAccount", accountId: boost.accountId },
    });
  }
};

/** The event a follower hears, or nothing when the entry is not on its home timeline. */
const followerEvent = async (
  env: Env,
  identity: InstanceIdentity,
  job: HomeEntryEvent,
  accountId: string,
): Promise<Result<StreamEventValue | undefined, RepositoryError>> => {
  if (job.event === "delete") {
    return ok({ kind: "delete", statusId: job.entryId });
  }
  const documents = await homeTimelineDocuments(env, identity, accountId, 1, {
    onlyId: job.entryId,
  });
  if (documents.isErr()) {
    return err(documents.error);
  }
  const [document] = documents.value.statuses;
  return ok(document ? { kind: job.event, payload: document } : undefined);
};

/**
 * The event a follower's list stream hears, or nothing when the list (the
 * follower's own, by the subscription's rules) does not hold the entry.
 */
const listEvent = async (
  env: Env,
  identity: InstanceIdentity,
  job: HomeEntryEvent,
  accountId: string,
  listId: string,
): Promise<Result<StreamEventValue | undefined, RepositoryError>> => {
  if (job.event === "delete") {
    return ok({ kind: "delete", statusId: job.entryId });
  }
  const list = await findListForAccount(env.DB, accountId, listId);
  if (list.isErr()) {
    return err(list.error);
  }
  if (!list.value) {
    return ok(undefined);
  }
  const documents = await listTimelineDocuments(env, identity, accountId, list.value, 1, {
    onlyId: job.entryId,
  });
  if (documents.isErr()) {
    return err(documents.error);
  }
  const [document] = documents.value.statuses;
  return ok(document ? { kind: job.event, payload: document } : undefined);
};

/**
 * Tell each account about the entry, with the document rendered for it, on
 * its `user` stream if open and on each list stream it has open whose list
 * holds the entry.
 * Redoing it only sends the events again, which clients take as the same
 * status. Writes its own `stream.render` points unless the caller passes the
 * tallies it shares across entries.
 */
export const announceHomeEntry = async (
  env: Env,
  identity: InstanceIdentity,
  entry: HomeEntryEvent,
  accountIds: ReadonlyArray<string>,
  renders?: HomeRenderTallies,
): Promise<Result<void, RepositoryError>> => {
  if (renders) {
    return announceHomeEntryTallied(env, identity, entry, accountIds, renders);
  }
  const own = homeRenderTallies(env);
  try {
    return await announceHomeEntryTallied(env, identity, entry, accountIds, own);
  } finally {
    flushHomeRenderTallies(own);
  }
};

/** The `stream.render` tallies of one fan-out pass (see `streamRenderTally`). */
type HomeRenderTallies = Readonly<{ home: StreamRenderTally; list: StreamRenderTally }>;

const homeRenderTallies = (env: Env): HomeRenderTallies => ({
  home: streamRenderTally(env, "home"),
  list: streamRenderTally(env, "list"),
});

const flushHomeRenderTallies = (renders: HomeRenderTallies): void => {
  renders.home.flush();
  renders.list.flush();
};

const announceHomeEntryTallied = async (
  env: Env,
  identity: InstanceIdentity,
  entry: HomeEntryEvent,
  accountIds: ReadonlyArray<string>,
  { home, list }: HomeRenderTallies,
): Promise<Result<void, RepositoryError>> => {
  const subscriptions = await listHubStreamSubscriptions(env.DB, accountIds, ["user", "list"]);
  if (subscriptions.isErr()) {
    return err(subscriptions.error);
  }
  const listening = new Set(
    subscriptions.value.filter(({ channel }) => channel.kind === "User").map(({ hub }) => hub),
  );
  // A hub drops an event for a stream it does not hold, so only accounts with
  // a `user` stream open are rendered for.
  for (const accountId of accountIds.filter((id) => listening.has(id))) {
    const event = await home.measure(() => followerEvent(env, identity, entry, accountId));
    if (event.isErr()) {
      return err(event.error);
    }
    if (event.value) {
      try {
        await publishToHub(env, accountId, { channels: [{ kind: "User" }], event: event.value });
      } catch {
        console.error(JSON.stringify({ kind: "HomeFanOutNotPublished", accountId }));
      }
    }
  }
  const lists = subscriptions.value.flatMap(({ hub, channel }) =>
    channel.kind === "List" ? [{ hub, listId: channel.listId }] : [],
  );
  for (const { hub: accountId, listId } of lists) {
    const event = await list.measure(() => listEvent(env, identity, entry, accountId, listId));
    if (event.isErr()) {
      return err(event.error);
    }
    if (event.value) {
      try {
        await publishToHub(env, accountId, {
          channels: [{ kind: "List", listId }],
          event: event.value,
        });
      } catch {
        console.error(JSON.stringify({ kind: "ListFanOutNotPublished", accountId }));
      }
    }
  }
  return ok(undefined);
};

/**
 * Tell the accounts an `Accounts` step names. A `List` step lists up to
 * `listSize` of the author's local followers, and of the local followers of
 * the entry's hashtags, with a `user` or `list` stream open, tells the first
 * page of them, and hands back the jobs for the rest: an `Accounts` job per
 * page, and a `List` job after the last follower listed when the listing was
 * full. Resolves to the followers told and those jobs.
 */
export const fanOutHomeStep = async (
  env: Env,
  identity: InstanceIdentity,
  job: FanOutHome,
  listSize: number = HOME_FAN_OUT_LIST_SIZE,
): Promise<Result<Readonly<{ recipients: number; next: FanOutHome[] }>, RepositoryError>> => {
  if (job.step.kind === "Accounts") {
    const { accountIds } = job.step;
    const announced = await announceHomeEntry(env, identity, job, accountIds);
    return announced.map(() => ({ recipients: accountIds.length, next: [] }));
  }
  const { afterAccountId } = job.step;
  const listed = await runD1(() =>
    queryTyped(
      env.DB,
      listHomeFanOutAccounts(
        job.author.kind === "LocalAccount" ? job.author.accountId : "",
        job.author.kind === "RemoteActor" ? job.author.actorUri : "",
        afterAccountId,
        listSize,
        job.entryId,
        signedInRecentlySince(env),
      ),
      AccountIdRow,
    ),
  );
  if (listed.isErr()) {
    return err(listed.error);
  }
  const accountIds = listed.value.map((row) => row.account_id);
  const first = accountIds.slice(0, HOME_FAN_OUT_PAGE_SIZE);
  const announced = await announceHomeEntry(env, identity, job, first);
  if (announced.isErr()) {
    return err(announced.error);
  }
  const next: FanOutHome[] = [];
  for (let at = HOME_FAN_OUT_PAGE_SIZE; at < accountIds.length; at += HOME_FAN_OUT_PAGE_SIZE) {
    next.push({
      ...job,
      step: { kind: "Accounts", accountIds: accountIds.slice(at, at + HOME_FAN_OUT_PAGE_SIZE) },
    });
  }
  const last = accountIds.at(-1);
  if (accountIds.length >= listSize && last !== undefined) {
    next.push({ ...job, step: { kind: "List", afterAccountId: last } });
  }
  return ok({ recipients: first.length, next });
};

/**
 * Handle one queued step of a home fan-out and queue the jobs it hands on.
 * The first page is told before the rest is queued, so a `List` step that
 * fails and is retried has queued no page yet.
 */
export const processFanOutHomeJob = (env: Env, job: FanOutHome): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, async () => {
    const step = job.step.kind;
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      return { outcome: "retry", size: 0, chained: false, step };
    }
    const told = await fanOutHomeStep(env, identity.value, job);
    if (told.isErr()) {
      return { outcome: "retry", size: 0, chained: false, step };
    }
    const { recipients, next } = told.value;
    if (next.length === 0) {
      return { outcome: "ok", size: recipients, chained: false, step };
    }
    const queued = await queueOutboxJobs(env, next);
    if (queued.isErr()) {
      console.error(JSON.stringify({ kind: "HomeFanOutNotQueued", entryId: job.entryId }));
      return { outcome: "ok", size: recipients, chained: false, step };
    }
    return { outcome: "ok", size: recipients, chained: true, step };
  });

/**
 * Accounts and entries per `FanOutRemovedStatuses` job: at most 20 x 20
 * stream publishes, plus one list lookup per entry, per queue invocation.
 */
export const REMOVED_STATUSES_JOB_ACCOUNTS = 20;
export const REMOVED_STATUSES_JOB_ENTRIES = 20;

/**
 * Queue telling `accountIds` that the entries are gone, in jobs of bounded
 * size, unless no hub holds a `user` or `list` stream. For entries whose
 * author is already purged, so the audience cannot be looked up from the
 * author. Best effort, like `startHomeFanOut`.
 */
export const enqueueRemovedStatusesFanOut = async (
  env: Env,
  accountIds: ReadonlyArray<string>,
  statusIds: ReadonlyArray<string>,
): Promise<void> => {
  if (accountIds.length === 0 || !(await streamListeners(env.DB)).home) {
    return;
  }
  for (let at = 0; at < accountIds.length; at += REMOVED_STATUSES_JOB_ACCOUNTS) {
    for (let from = 0; from < statusIds.length; from += REMOVED_STATUSES_JOB_ENTRIES) {
      const job = OutboxJob.parse({
        kind: "FanOutRemovedStatuses",
        accountIds: accountIds.slice(at, at + REMOVED_STATUSES_JOB_ACCOUNTS),
        statusIds: statusIds.slice(from, from + REMOVED_STATUSES_JOB_ENTRIES),
      });
      if (job.isErr()) {
        continue;
      }
      try {
        await env.OUTBOX_PROCESS_QUEUE.send(job.value);
      } catch {
        console.error(JSON.stringify({ kind: "RemovedStatusesFanOutNotQueued" }));
      }
    }
  }
};

/**
 * Tell the listed accounts that each listed entry is gone.
 */
export const processFanOutRemovedStatusesJob = (
  env: Env,
  job: FanOutRemovedStatuses,
): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, async () => {
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      return { outcome: "retry", size: 0, chained: false };
    }
    // One `stream.render` point per target for the whole job, not per entry:
    // a queue batch of these jobs would otherwise pass Analytics Engine's
    // per-invocation cap.
    const renders = homeRenderTallies(env);
    try {
      for (const entryId of job.statusIds) {
        const announced = await announceHomeEntry(
          env,
          identity.value,
          { event: "delete", entryId },
          job.accountIds,
          renders,
        );
        if (announced.isErr()) {
          return { outcome: "retry", size: 0, chained: false };
        }
      }
    } finally {
      flushHomeRenderTallies(renders);
    }
    // Entries times accounts told; the job is one page and never chains.
    return { outcome: "ok", size: job.statusIds.length * job.accountIds.length, chained: false };
  });
