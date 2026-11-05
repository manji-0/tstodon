import {
  type OutboxJobValue,
  type StatusCleanupFacts,
  StatusesCleanupPolicy,
  type LocalNote,
  LocalAccountModeration,
} from "@tstodon/domain";
import { findLocalAccountModeration } from "./account-moderation-store";
import { findAccountById } from "./account-store";
import { chunkArray } from "./d1";
import { deleteLocalStatus } from "./local-status-delete";
import { parseInstanceIdentity } from "./runtime-config";
import { listPinnedStatuses } from "./status-pin-store";
import { statusInteractionCountsByIds } from "./status-interaction-store";
import {
  findCleanupCursor,
  findStatusesCleanupPolicy,
  listCleanupCandidates,
  listEnabledCleanupAccountIds,
  saveCleanupCursor,
} from "./statuses-cleanup-store";

/** How many old posts one run looks at per account, deleted or kept. */
export const CLEANUP_SCAN_BATCH = 100;

/** How many posts one run deletes per account. */
export const CLEANUP_DELETE_BATCH = 20;

/** Queue messages per `sendBatch`, the platform maximum. */
const QUEUE_BATCH = 100;

/** Cron path: queue one cleanup run for each account whose policy is on. */
export const queueStatusesCleanup = async (env: Env): Promise<void> => {
  const accountIds = await listEnabledCleanupAccountIds(env.DB);
  if (accountIds.isErr()) {
    return;
  }
  for (const chunk of chunkArray(accountIds.value, QUEUE_BATCH)) {
    await env.OUTBOX_PROCESS_QUEUE.sendBatch(
      chunk.map((accountId) => ({
        body: { kind: "CleanUpAccountStatuses", accountId } satisfies OutboxJobValue,
      })),
    );
  }
};

const factsOf = (
  note: LocalNote,
  pinnedIds: ReadonlySet<string>,
  counts: Awaited<ReturnType<typeof statusInteractionCountsByIds>>,
): StatusCleanupFacts => {
  const interactions = counts.isOk() ? counts.value.get(note.id) : undefined;
  return {
    createdAtMs: Date.parse(note.createdAt),
    visibility: note.visibility,
    pinned: pinnedIds.has(note.id),
    favouritedBySelf: interactions?.favourited ?? false,
    bookmarkedBySelf: interactions?.bookmarked ?? false,
    hasPoll: note.poll.kind === "Present",
    hasMedia: note.mediaIds.length > 0,
    favouritesCount: interactions?.favourites ?? 0,
    boostsCount: interactions?.reblogs ?? 0,
  };
};

/**
 * Delete the next batch of one account's posts that its policy removes.
 * A run looks at up to {@link CLEANUP_SCAN_BATCH} old posts after the one the
 * last run stopped at and deletes up to {@link CLEANUP_DELETE_BATCH} of them
 * through the same path as `DELETE /api/v1/statuses/:id`. It remembers where
 * it stopped so posts it keeps do not hold up the older ones behind them, and
 * starts over from the oldest post once it reaches the end.
 */
export const cleanUpAccountStatuses = async (
  env: Env,
  accountId: string,
): Promise<Readonly<{ scanned: number }>> => {
  const identity = parseInstanceIdentity(env);
  const policy = await findStatusesCleanupPolicy(env.DB, accountId);
  if (identity.isErr() || policy.isErr() || policy.value.kind === "Disabled") {
    return { scanned: 0 };
  }
  const account = await findAccountById(env.DB, accountId);
  if (account.isErr() || !account.value) {
    return { scanned: 0 };
  }
  const moderation = await findLocalAccountModeration(env.DB, accountId);
  if (moderation.isOk() && LocalAccountModeration.isBarred(moderation.value)) {
    return { scanned: 0 };
  }
  const now = Date.now();
  const cutoff = new Date(now - policy.value.rules.minAgeSeconds * 1000).toISOString();
  const cursor = await findCleanupCursor(env.DB, accountId);
  if (cursor.isErr()) {
    return { scanned: 0 };
  }
  const candidates = await listCleanupCandidates(
    env.DB,
    accountId,
    cursor.value,
    cutoff,
    CLEANUP_SCAN_BATCH,
  );
  const pinned = await listPinnedStatuses(env.DB, accountId);
  if (candidates.isErr() || pinned.isErr()) {
    return { scanned: 0 };
  }
  const pinnedIds = new Set(pinned.value.map((status) => status.id));
  const counts = await statusInteractionCountsByIds(
    env.DB,
    candidates.value.map((note) => note.id),
    accountId,
  );
  if (counts.isErr()) {
    // Without the counts a keep rule could not hold; try again next run.
    return { scanned: 0 };
  }
  let deleted = 0;
  let stoppedAt = "";
  for (const note of candidates.value) {
    if (!StatusesCleanupPolicy.shouldDelete(policy.value, factsOf(note, pinnedIds, counts), now)) {
      stoppedAt = note.id;
      continue;
    }
    // A failed delete is retried by a later pass over this post.
    const removed = await deleteLocalStatus(env, identity.value, account.value, note);
    stoppedAt = note.id;
    deleted += removed.isOk() && removed.value ? 1 : 0;
    if (deleted >= CLEANUP_DELETE_BATCH) {
      break;
    }
  }
  const reachedEnd = candidates.value.length < CLEANUP_SCAN_BATCH && deleted < CLEANUP_DELETE_BATCH;
  await saveCleanupCursor(env.DB, accountId, reachedEnd ? "" : stoppedAt);
  return { scanned: candidates.value.length };
};
