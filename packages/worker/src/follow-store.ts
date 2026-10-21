import { FollowRequest, LocalFollow } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { parseJsonColumn } from "./json-column";
import { queryTyped, runTyped } from "./typed-sql";
import {
  authorizeFollowRequest as authorizeFollowRequestSql,
  deleteFollow as deleteFollowSql,
  findFollowKind as findFollowKindSql,
  insertFollowOrIgnore as insertFollowOrIgnoreSql,
  listAcceptedFollowerIds as listAcceptedFollowerIdsSql,
  listFamiliarFollowerIds as listFamiliarFollowerIdsSql,
  listFollowingAccountIds as listFollowingAccountIdsSql,
  listNotifyingFollowerIds as listNotifyingFollowerIdsSql,
  rejectFollowRequest as rejectFollowRequestSql,
  upsertFollowOptions as upsertFollowOptionsSql,
} from "./generated/prisma/sql";

/** Mastodon's per-follow options; omitted fields keep their defaults. */
export type FollowOptions = Readonly<{
  reblogs?: boolean;
  notify?: boolean;
  languages?: ReadonlyArray<string>;
}>;

export const followAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
  targetLocked: boolean,
  options: FollowOptions = {},
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
    const existing = await queryTyped<{
      kind: string;
      reblogs: number;
      notify: number;
      languages_json: string;
    }>(db, findFollowKindSql(followerId, targetId));
    const row = existing[0];
    if (
      options.reblogs !== undefined ||
      options.notify !== undefined ||
      options.languages !== undefined
    ) {
      // Following again updates the existing row, as Mastodon does.
      await runTyped(
        db,
        upsertFollowOptionsSql(
          followerId,
          targetId,
          (options.reblogs ?? (row ? row.reblogs !== 0 : true)) ? 1 : 0,
          (options.notify ?? (row ? row.notify !== 0 : false)) ? 1 : 0,
          JSON.stringify(
            options.languages ??
              (row
                ? (parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr(
                    [],
                  ) as string[])
                : []),
          ),
        ),
      );
    }
    if (inserted.length > 0) {
      return state;
    }
    return FollowRequest.parse({
      kind: "LocalFollower",
      targetLocked,
      follow: row?.kind === "Accepted" ? LocalFollow.Accepted : LocalFollow.Pending,
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
  cursor: IdCursor = {},
): Promise<Result<PendingFollowRequester[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT follower_account_id, created_at FROM follows
         WHERE target_account_id = ? AND kind = 'Pending' ${where} ${order} LIMIT ?`,
      )
      .bind(targetAccountId, ...binds, limit)
      .all();
    const rows = (results ?? []) as Array<{ follower_account_id: string; created_at: string }>;
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

/** The follow kind between two local accounts, when any. */
export const findFollowKind = async (
  db: D1Database,
  followerId: string,
  targetId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ kind: string }>(db, findFollowKindSql(followerId, targetId));
    return rows[0]?.kind;
  });

/**
 * Accounts the viewer follows that also follow `targetId` — "familiar
 * followers" of a shared target, ordered by username, capped at `limit`.
 */
export const familiarFollowerIds = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      listFamiliarFollowerIdsSql(viewerId, targetId, limit),
    );
    return rows.map((row) => row.id);
  });

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

/** One follow edge: its row id is the cursor, the account is the document. */
export type FollowEdge = Readonly<{ id: string; accountId: string }>;

export const listFollowers = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<FollowEdge[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, follower_account_id FROM follows
         WHERE target_account_id = ? AND kind = 'Accepted' ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all<{ id: string; follower_account_id: string }>();
    return (results ?? []).map((row) => ({ id: row.id, accountId: row.follower_account_id }));
  });

/** Local followers who asked for a notification on every new status. */
export const notifyingFollowerIds = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ follower_account_id: string }>(
      db,
      listNotifyingFollowerIdsSql(accountId),
    );
    return rows.map((row) => row.follower_account_id);
  });

/** Every local account the viewer follows, for `following=true` searches. */
export const followingAccountIds = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ target_account_id: string }>(
      db,
      listFollowingAccountIdsSql(accountId),
    );
    return new Set(rows.map((row) => row.target_account_id));
  });

export const listFollowing = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<FollowEdge[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT id, target_account_id FROM follows
         WHERE follower_account_id = ? AND kind = 'Accepted' ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all<{ id: string; target_account_id: string }>();
    return (results ?? []).map((row) => ({ id: row.id, accountId: row.target_account_id }));
  });
