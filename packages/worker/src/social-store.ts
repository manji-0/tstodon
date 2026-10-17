import { FollowRequest, LocalFollow } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, runD1, runD1Batch, sqlInJsonEach, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  authorizeFollowRequest as authorizeFollowRequestSql,
  deleteBlock as deleteBlockSql,
  deleteBookmark as deleteBookmarkSql,
  deleteFavourite as deleteFavouriteSql,
  deleteFollow as deleteFollowSql,
  deleteMute as deleteMuteSql,
  findActiveMute as findActiveMuteSql,
  findBlock as findBlockSql,
  findFollowKind as findFollowKindSql,
  insertBookmarkOrIgnore as insertBookmarkOrIgnoreSql,
  insertFavouriteOrIgnore as insertFavouriteOrIgnoreSql,
  insertFollowOrIgnore as insertFollowOrIgnoreSql,
  insertNotification as insertNotificationSql,
  listAcceptedFollowerIds as listAcceptedFollowerIdsSql,
  listBlockedAccounts as listBlockedAccountsSql,
  listFollowers as listFollowersSql,
  listFollowing as listFollowingSql,
  listMutedAccounts as listMutedAccountsSql,
  listNotifications as listNotificationsSql,
  listPendingFollowRequesters as listPendingFollowRequestersSql,
  rejectFollowRequest as rejectFollowRequestSql,
  upsertBlock as upsertBlockSql,
  upsertMute as upsertMuteSql,
} from "./generated/prisma/sql";

export const followAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
  targetLocked: boolean,
): Promise<Result<FollowRequest, RepositoryError>> =>
  runD1(async () => {
    const state = FollowRequest.initial("LocalFollower", targetLocked);
    const followKind = state.kind === "LocalFollower" ? state.follow.kind : "Pending";
    if (followKind === "None") {
      return state;
    }
    const inserted = await queryTyped<{ id: string }>(
      db,
      insertFollowOrIgnoreSql(newEntityId(), followerId, targetId, followKind, nowIso()),
    );
    if (inserted.length > 0) {
      return state;
    }
    const existing = await queryTyped<{ kind: string }>(
      db,
      findFollowKindSql(followerId, targetId),
    );
    return FollowRequest.parse({
      kind: "LocalFollower",
      targetLocked,
      follow: existing[0]?.kind === "Accepted" ? LocalFollow.Accepted : LocalFollow.Pending,
    }).unwrapOr(state);
  });

export const unfollowAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteFollowSql(followerId, targetId));
  });

export type PendingFollowRequester = Readonly<{
  followerAccountId: string;
  createdAt: string;
}>;

export const listPendingFollowRequesters = async (
  db: D1Database,
  targetAccountId: string,
  limit: number,
): Promise<Result<PendingFollowRequester[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ follower_account_id: string; created_at: string }>(
      db,
      listPendingFollowRequestersSql(targetAccountId, limit),
    );
    return rows.map((row) => ({
      followerAccountId: row.follower_account_id,
      createdAt: row.created_at,
    }));
  });

/** Promote a `Pending` follow to `Accepted`. Returns true when a row moved. */
export const authorizeFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  followerAccountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ follower_account_id: string }>(
      db,
      authorizeFollowRequestSql(targetAccountId, followerAccountId),
    );
    return rows.length > 0;
  });

/** Remove a `Pending` follow. Returns true when a row was deleted. */
export const rejectFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  followerAccountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ follower_account_id: string }>(
      db,
      rejectFollowRequestSql(targetAccountId, followerAccountId),
    );
    return rows.length > 0;
  });

export type BlockedAccount = Readonly<{
  accountId: string;
  targetActorUri: string;
  createdAt: string;
}>;

export type MutedAccount = Readonly<{
  accountId: string;
  targetActorUri: string;
  notifications: boolean;
  expiresAt: string | null;
  createdAt: string;
}>;

export const blockAccount = async (
  db: D1Database,
  blockerAccountId: string,
  targetAccountId: string | null,
  targetActorUri: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, upsertBlockSql(blockerAccountId, targetAccountId, targetActorUri, nowIso()));
  });

export const unblockAccount = async (
  db: D1Database,
  blockerAccountId: string,
  targetActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ target_actor_uri: string }>(
      db,
      deleteBlockSql(blockerAccountId, targetActorUri),
    );
    return rows.length > 0;
  });

export const muteAccount = async (
  db: D1Database,
  accountId: string,
  targetAccountId: string | null,
  targetActorUri: string,
  input: Readonly<{ notifications: boolean; expiresAt: string | null }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      upsertMuteSql(
        accountId,
        targetAccountId,
        targetActorUri,
        input.notifications ? 1 : 0,
        input.expiresAt,
        nowIso(),
      ),
    );
  });

export const unmuteAccount = async (
  db: D1Database,
  accountId: string,
  targetActorUri: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ target_actor_uri: string }>(
      db,
      deleteMuteSql(accountId, targetActorUri),
    );
    return rows.length > 0;
  });

export const listBlockedAccounts = async (
  db: D1Database,
  blockerAccountId: string,
  limit: number,
): Promise<Result<BlockedAccount[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{
      target_account_id: string | null;
      target_actor_uri: string;
      created_at: string;
    }>(db, listBlockedAccountsSql(blockerAccountId, limit));
    return rows.flatMap((row) =>
      row.target_account_id
        ? [
            {
              accountId: row.target_account_id,
              targetActorUri: row.target_actor_uri,
              createdAt: row.created_at,
            },
          ]
        : [],
    );
  });

export const listMutedAccounts = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<MutedAccount[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{
      target_account_id: string | null;
      target_actor_uri: string;
      notifications: number;
      expires_at: string | null;
      created_at: string;
    }>(db, listMutedAccountsSql(accountId, nowIso(), limit));
    return rows.flatMap((row) =>
      row.target_account_id
        ? [
            {
              accountId: row.target_account_id,
              targetActorUri: row.target_actor_uri,
              notifications: row.notifications !== 0,
              expiresAt: row.expires_at,
              createdAt: row.created_at,
            },
          ]
        : [],
    );
  });

export type RelationshipFlags = Readonly<{
  following: boolean;
  followedBy: boolean;
  requested: boolean;
  blocking: boolean;
  blockedBy: boolean;
  muting: boolean;
  mutingNotifications: boolean;
  mutingExpiresAt: string | null;
}>;

export const relationshipFlags = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<Result<RelationshipFlags, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, findFollowKindSql(viewerId, targetId)),
    d1PrepareTyped(db, findFollowKindSql(targetId, viewerId)),
    d1PrepareTyped(db, findBlockSql(viewerId, targetId)),
    d1PrepareTyped(db, findBlockSql(targetId, viewerId)),
    d1PrepareTyped(db, findActiveMuteSql(viewerId, targetId, nowIso())),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const outgoing = batched.value[0]?.results?.[0] as { kind: string } | undefined;
  const incoming = batched.value[1]?.results?.[0] as { kind: string } | undefined;
  const blocking = (batched.value[2]?.results?.length ?? 0) > 0;
  const blockedBy = (batched.value[3]?.results?.length ?? 0) > 0;
  const mute = batched.value[4]?.results?.[0] as
    | { notifications: number; expires_at: string | null }
    | undefined;
  return ok({
    following: outgoing?.kind === "Accepted",
    followedBy: incoming?.kind === "Accepted",
    requested: outgoing?.kind === "Pending",
    blocking,
    blockedBy,
    muting: mute !== undefined,
    mutingNotifications: mute ? mute.notifications !== 0 : false,
    mutingExpiresAt: mute?.expires_at ?? null,
  });
};

/**
 * SQL fragment selecting the account ids a viewer must not see: accounts the
 * viewer blocks, accounts that block the viewer, and active muted accounts.
 * Bind order: (viewerId, viewerId, viewerId, nowIso).
 */
export const SUPPRESSED_ACCOUNT_IDS_SQL = `(
  SELECT target_account_id FROM blocks
    WHERE blocker_account_id = ? AND target_account_id IS NOT NULL
  UNION
  SELECT blocker_account_id FROM blocks
    WHERE target_account_id = ? AND blocker_account_id IS NOT NULL
  UNION
  SELECT target_account_id FROM mutes
    WHERE account_id = ? AND target_account_id IS NOT NULL
      AND (expires_at IS NULL OR expires_at > ?)
)`;

export const favouriteStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, insertFavouriteOrIgnoreSql(accountId, statusId, nowIso()));
    return rows.length > 0;
  });

export const unfavouriteStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteFavouriteSql(accountId, statusId));
  });

export const bookmarkStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, insertBookmarkOrIgnoreSql(accountId, statusId, nowIso()));
  });

export const unbookmarkStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteBookmarkSql(accountId, statusId));
  });

export const insertNotification = async (
  db: D1Database,
  input: {
    accountId: string;
    fromAccountId: string;
    kind: string;
    statusId?: string;
  },
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertNotificationSql(
        newEntityId(),
        input.accountId,
        input.fromAccountId,
        input.kind,
        input.statusId ?? null,
        nowIso(),
      ),
    );
  });

export type NotificationRow = {
  id: string;
  account_id: string;
  from_account_id: string;
  kind: string;
  status_id: string | null;
  created_at: string;
};

export const listNotifications = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<NotificationRow[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<NotificationRow>(
      db,
      listNotificationsSql(accountId, nowIso(), limit),
    );
    return results.map((row) => ({
      id: row.id ?? "",
      account_id: row.account_id,
      from_account_id: row.from_account_id,
      kind: row.kind,
      status_id: row.status_id,
      created_at: row.created_at,
    }));
  });

export type StatusInteractionCounts = Readonly<{
  favourites: number;
  reblogs: number;
  favourited: boolean;
  reblogged: boolean;
  bookmarked: boolean;
}>;

const emptyInteractionCounts = (): StatusInteractionCounts => ({
  favourites: 0,
  reblogs: 0,
  favourited: false,
  reblogged: false,
  bookmarked: false,
});

export const statusInteractionCounts = async (
  db: D1Database,
  statusId: string,
  viewerId: string | undefined,
): Promise<Result<StatusInteractionCounts, RepositoryError>> => {
  const bulk = await statusInteractionCountsByIds(db, [statusId], viewerId);
  if (bulk.isErr()) {
    return err(bulk.error);
  }
  return ok(bulk.value.get(statusId) ?? emptyInteractionCounts());
};

export const statusInteractionCountsByIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  viewerId: string | undefined,
): Promise<Result<Map<string, StatusInteractionCounts>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  const counts = new Map<string, StatusInteractionCounts>();
  for (const id of unique) {
    counts.set(id, emptyInteractionCounts());
  }
  if (unique.length === 0) {
    return ok(counts);
  }

  const bump = (statusId: string, patch: Partial<StatusInteractionCounts>): void => {
    const current = counts.get(statusId) ?? emptyInteractionCounts();
    counts.set(statusId, { ...current, ...patch });
  };

  const idsJson = jsonStringArray(unique);
  const inList = sqlInJsonEach();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT status_id, COUNT(*) AS count FROM favourites
         WHERE status_id ${inList} GROUP BY status_id`,
      )
      .bind(idsJson),
    db
      .prepare(
        `SELECT reblog_of_id AS status_id, COUNT(*) AS count FROM statuses
         WHERE kind = 'LocalReblog' AND reblog_of_id ${inList}
         GROUP BY reblog_of_id`,
      )
      .bind(idsJson),
    db
      .prepare(
        `SELECT status_id, COUNT(*) AS count FROM remote_favourites
         WHERE status_id ${inList} GROUP BY status_id`,
      )
      .bind(idsJson),
    db
      .prepare(
        `SELECT status_id, COUNT(*) AS count FROM remote_announces
         WHERE status_id ${inList} GROUP BY status_id`,
      )
      .bind(idsJson),
  ];
  if (viewerId) {
    statements.push(
      db
        .prepare(
          `SELECT status_id FROM favourites
           WHERE account_id = ? AND status_id ${inList}`,
        )
        .bind(viewerId, idsJson),
      db
        .prepare(
          `SELECT reblog_of_id AS status_id FROM statuses
           WHERE kind = 'LocalReblog' AND account_id = ? AND reblog_of_id ${inList}`,
        )
        .bind(viewerId, idsJson),
      db
        .prepare(
          `SELECT status_id FROM bookmarks
           WHERE account_id = ? AND status_id ${inList}`,
        )
        .bind(viewerId, idsJson),
    );
  }
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const countRows = (index: number): Array<{ status_id: string; count: number }> =>
    (batched.value[index]?.results ?? []) as Array<{ status_id: string; count: number }>;
  const idRows = (index: number): Array<{ status_id: string }> =>
    (batched.value[index]?.results ?? []) as Array<{ status_id: string }>;

  for (const row of countRows(0)) {
    bump(row.status_id, {
      favourites: (counts.get(row.status_id)?.favourites ?? 0) + row.count,
    });
  }
  for (const row of countRows(2)) {
    bump(row.status_id, {
      favourites: (counts.get(row.status_id)?.favourites ?? 0) + row.count,
    });
  }
  for (const row of countRows(1)) {
    bump(row.status_id, {
      reblogs: (counts.get(row.status_id)?.reblogs ?? 0) + row.count,
    });
  }
  for (const row of countRows(3)) {
    bump(row.status_id, {
      reblogs: (counts.get(row.status_id)?.reblogs ?? 0) + row.count,
    });
  }
  if (viewerId) {
    for (const row of idRows(4)) {
      bump(row.status_id, { favourited: true });
    }
    for (const row of idRows(5)) {
      bump(row.status_id, { reblogged: true });
    }
    for (const row of idRows(6)) {
      bump(row.status_id, { bookmarked: true });
    }
  }
  return ok(counts);
};

export const listAcceptedFollowerIds = async (
  db: D1Database,
  targetAccountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ follower_account_id: string }>(
      db,
      listAcceptedFollowerIdsSql(targetAccountId),
    );
    return results.map((row) => row.follower_account_id);
  });

export const listFollowers = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ follower_account_id: string }>(
      db,
      listFollowersSql(accountId, limit),
    );
    return results.map((row) => row.follower_account_id);
  });

export const listFollowing = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped<{ target_account_id: string }>(
      db,
      listFollowingSql(accountId, limit),
    );
    return results.map((row) => row.target_account_id);
  });
