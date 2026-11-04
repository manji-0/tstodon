import { FollowRequest, LocalFollow } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { parseJsonColumn } from "./json-column";
import { RemoteAccountId } from "./remote-account-id";
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

const IdRow = z.object({ id: z.string() });
const Row2 = z.object({
  kind: z.string(),
  reblogs: z.number(),
  notify: z.number(),
  languages_json: z.string(),
});
const FollowerAccountIdRow = z.object({ follower_account_id: z.string() });
const KindRow = z.object({ kind: z.string() });
const TargetAccountIdRow = z.object({ target_account_id: z.string() });

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
    const inserted = await queryTyped(
      db,
      insertFollowOrIgnoreSql(newEntityId(), followerId, targetId, followKind, nowIso()),
      IdRow,
    );
    const existing = await queryTyped(db, findFollowKindSql(followerId, targetId), Row2);
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
              (row ? parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr([]) : []),
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
    const rows = parseRows(
      z.object({ follower_account_id: z.string(), created_at: z.string() }),
      results,
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
    const rows = await queryTyped(
      db,
      authorizeFollowRequestSql(targetAccountId, followerAccountId),
      FollowerAccountIdRow,
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
    const rows = await queryTyped(
      db,
      rejectFollowRequestSql(targetAccountId, followerAccountId),
      FollowerAccountIdRow,
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
    const rows = await queryTyped(db, findFollowKindSql(followerId, targetId), KindRow);
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
    const rows = await queryTyped(db, listFamiliarFollowerIdsSql(viewerId, targetId, limit), IdRow);
    return rows.map((row) => row.id);
  });

export const listAcceptedFollowerIds = async (
  db: D1Database,
  targetAccountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(
      db,
      listAcceptedFollowerIdsSql(targetAccountId),
      FollowerAccountIdRow,
    );
    return results.map((row) => row.follower_account_id);
  });

/** One follow edge: its row id is the cursor, the account is the document. */
export type FollowEdge = Readonly<{ id: string; accountId: string }>;

const FollowEdgeRowSchema = z.object({
  id: z.string(),
  account_id: z.string().nullable(),
  actor_uri: z.string().nullable(),
});

/** A local account edge keeps its id; a remote actor edge becomes its `r_…` id. */
const followEdges = (results: ReadonlyArray<unknown> | undefined): FollowEdge[] =>
  parseRows(FollowEdgeRowSchema, results).flatMap((row) => {
    const target =
      row.account_id ?? (row.actor_uri ? RemoteAccountId.encode(row.actor_uri) : undefined);
    return target ? [{ id: row.id, accountId: target }] : [];
  });

/**
 * Accepted followers, local accounts and remote actors (as `r_…` ids), one
 * list ordered by follow row id.
 */
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
        `SELECT id, account_id, actor_uri FROM (
           SELECT id, follower_account_id AS account_id, NULL AS actor_uri FROM follows
           WHERE target_account_id = ? AND kind = 'Accepted'
           UNION ALL
           SELECT id, NULL, remote_actor_uri FROM remote_follows
           WHERE target_account_id = ? AND follow_kind = 'Accepted'
         ) WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, accountId, ...binds, limit)
      .all();
    return followEdges(results);
  });

/** Local followers who asked for a notification on every new status. */
export const notifyingFollowerIds = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listNotifyingFollowerIdsSql(accountId), FollowerAccountIdRow);
    return rows.map((row) => row.follower_account_id);
  });

/** Every local account the viewer follows, for `following=true` searches. */
export const followingAccountIds = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listFollowingAccountIdsSql(accountId), TargetAccountIdRow);
    return new Set(rows.map((row) => row.target_account_id));
  });

/**
 * Accepted follows of local accounts and of remote actors (as `r_…` ids), one
 * list ordered by follow row id.
 */
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
        `SELECT id, account_id, actor_uri FROM (
           SELECT id, target_account_id AS account_id, NULL AS actor_uri FROM follows
           WHERE follower_account_id = ? AND kind = 'Accepted'
           UNION ALL
           SELECT id, NULL, actor_uri FROM outbound_follows
           WHERE account_id = ? AND state = 'Accepted'
         ) WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, accountId, ...binds, limit)
      .all();
    return followEdges(results);
  });
