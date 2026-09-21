import { FollowRequest, LocalFollow } from "@tstodon/domain";
import { runD1, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import type { Result } from "neverthrow";

export const followAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
  targetLocked: boolean,
): Promise<Result<FollowRequest, RepositoryError>> =>
  runD1(async () => {
    const existing = await db
      .prepare(
        `SELECT kind FROM follows WHERE follower_account_id = ? AND target_account_id = ?`,
      )
      .bind(followerId, targetId)
      .first<{ kind: string }>();
    if (existing) {
      return FollowRequest.parse({
        kind: "LocalFollower",
        targetLocked,
        follow: existing.kind === "Accepted" ? LocalFollow.Accepted : LocalFollow.Pending,
      }).unwrapOr(
        FollowRequest.initial("LocalFollower", targetLocked),
      );
    }
    const state = FollowRequest.initial("LocalFollower", targetLocked);
    const followKind = state.kind === "LocalFollower" ? state.follow.kind : "Pending";
    if (followKind !== "None") {
      await db
        .prepare(
          `INSERT INTO follows (id, follower_account_id, target_account_id, kind, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(newEntityId(), followerId, targetId, followKind, nowIso())
        .run();
    }
    return state;
  });

export const unfollowAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM follows WHERE follower_account_id = ? AND target_account_id = ?`,
      )
      .bind(followerId, targetId)
      .run();
  });

export const relationshipFlags = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<
  Result<
    Readonly<{ following: boolean; followedBy: boolean; requested: boolean }>,
    RepositoryError
  >
> =>
  runD1(async () => {
    const outgoing = await db
      .prepare(
        `SELECT kind FROM follows WHERE follower_account_id = ? AND target_account_id = ?`,
      )
      .bind(viewerId, targetId)
      .first<{ kind: string }>();
    const incoming = await db
      .prepare(
        `SELECT kind FROM follows WHERE follower_account_id = ? AND target_account_id = ?`,
      )
      .bind(targetId, viewerId)
      .first<{ kind: string }>();
    return {
      following: outgoing?.kind === "Accepted",
      followedBy: incoming?.kind === "Accepted",
      requested: outgoing?.kind === "Pending",
    };
  });

export const favouriteStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO favourites (account_id, status_id, created_at) VALUES (?, ?, ?)`,
      )
      .bind(accountId, statusId, nowIso())
      .run();
    return (result.meta.changes ?? 0) > 0;
  });

export const unfavouriteStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(`DELETE FROM favourites WHERE account_id = ? AND status_id = ?`)
      .bind(accountId, statusId)
      .run();
  });

export const bookmarkStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT OR IGNORE INTO bookmarks (account_id, status_id, created_at) VALUES (?, ?, ?)`,
      )
      .bind(accountId, statusId, nowIso())
      .run();
  });

export const unbookmarkStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(`DELETE FROM bookmarks WHERE account_id = ? AND status_id = ?`)
      .bind(accountId, statusId)
      .run();
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
    await db
      .prepare(
        `INSERT INTO notifications (id, account_id, from_account_id, kind, status_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newEntityId(),
        input.accountId,
        input.fromAccountId,
        input.kind,
        input.statusId ?? null,
        nowIso(),
      )
      .run();
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
    const { results } = await db
      .prepare(
        `SELECT id, account_id, from_account_id, kind, status_id, created_at
         FROM notifications WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all<NotificationRow>();
    return results ?? [];
  });

export const statusInteractionCounts = async (
  db: D1Database,
  statusId: string,
  viewerId: string | undefined,
): Promise<
  Result<
    Readonly<{
      favourites: number;
      reblogs: number;
      favourited: boolean;
      reblogged: boolean;
      bookmarked: boolean;
    }>,
    RepositoryError
  >
> =>
  runD1(async () => {
    const favs = await db
      .prepare(`SELECT COUNT(*) AS count FROM favourites WHERE status_id = ?`)
      .bind(statusId)
      .first<{ count: number }>();
    const reblogs = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM statuses WHERE kind = 'LocalReblog' AND reblog_of_id = ?`,
      )
      .bind(statusId)
      .first<{ count: number }>();
    const remoteFavs = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM remote_favourites WHERE status_id = ?`,
      )
      .bind(statusId)
      .first<{ count: number }>();
    const remoteReblogs = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM remote_announces WHERE status_id = ?`,
      )
      .bind(statusId)
      .first<{ count: number }>();
    const favourited = viewerId
      ? await db
          .prepare(
            `SELECT 1 AS ok FROM favourites WHERE status_id = ? AND account_id = ?`,
          )
          .bind(statusId, viewerId)
          .first()
      : null;
    const reblogged = viewerId
      ? await db
          .prepare(
            `SELECT 1 AS ok FROM statuses WHERE kind = 'LocalReblog' AND reblog_of_id = ? AND account_id = ?`,
          )
          .bind(statusId, viewerId)
          .first()
      : null;
    const bookmarked = viewerId
      ? await db
          .prepare(
            `SELECT 1 AS ok FROM bookmarks WHERE status_id = ? AND account_id = ?`,
          )
          .bind(statusId, viewerId)
          .first()
      : null;
    return {
      favourites: (favs?.count ?? 0) + (remoteFavs?.count ?? 0),
      reblogs: (reblogs?.count ?? 0) + (remoteReblogs?.count ?? 0),
      favourited: Boolean(favourited),
      reblogged: Boolean(reblogged),
      bookmarked: Boolean(bookmarked),
    };
  });

export const listAcceptedFollowerIds = async (
  db: D1Database,
  targetAccountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT follower_account_id FROM follows
         WHERE target_account_id = ? AND kind = 'Accepted'`,
      )
      .bind(targetAccountId)
      .all<{ follower_account_id: string }>();
    return (results ?? []).map((row) => row.follower_account_id);
  });

export const listFollowers = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT follower_account_id FROM follows
         WHERE target_account_id = ? AND kind = 'Accepted'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all<{ follower_account_id: string }>();
    return (results ?? []).map((row) => row.follower_account_id);
  });

export const listFollowing = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT target_account_id FROM follows
         WHERE follower_account_id = ? AND kind = 'Accepted'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all<{ target_account_id: string }>();
    return (results ?? []).map((row) => row.target_account_id);
  });
