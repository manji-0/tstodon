import { LocalFollow, type NotifyingFollower } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, type MaxIdCursor, idCursorFragment } from "./id-cursor";
import { parseJsonColumn } from "./json-column";
import type { NotifyingFollowerPage } from "./outbound-follow-store";
import { RemoteAccountId } from "./remote-account-id";
import { queryTyped, runTyped } from "./typed-sql";
import {
  authorizeFollowRequest as authorizeFollowRequestSql,
  deleteFollow as deleteFollowSql,
  findFollowKind as findFollowKindSql,
  insertFollowOrIgnore as insertFollowOrIgnoreSql,
  listAcceptedFollowerIds as listAcceptedFollowerIdsSql,
  listFamiliarFollowerIdsJson as listFamiliarFollowerIdsJsonSql,
  listFollowingAccountIds as listFollowingAccountIdsSql,
  listNotifyingFollowers as listNotifyingFollowersSql,
  listNotifyingFollowersAmong as listNotifyingFollowersAmongSql,
  rejectFollowRequest as rejectFollowRequestSql,
  upsertFollowOptions as upsertFollowOptionsSql,
} from "./generated/prisma/sql";

const IdRow = z.object({ id: z.string() });
const OptionsRow = z.object({
  reblogs: z.number(),
  notify: z.number(),
  languages_json: z.string(),
});
const FollowerAccountIdRow = z.object({ follower_account_id: z.string() });
const NotifyingFollowerRow = z.object({
  id: z.string(),
  follower_account_id: z.string(),
  languages_json: z.string(),
});
const NotifyingFollowerAmongRow = NotifyingFollowerRow.omit({ id: true });
const KindRow = z.object({ kind: z.string() });
const TargetAccountIdRow = z.object({ target_account_id: z.string() });

/** Mastodon's per-follow options; omitted fields keep their defaults. */
export type FollowOptions = Readonly<{
  reblogs?: boolean;
  notify?: boolean;
  languages?: ReadonlyArray<string>;
}>;

/** What `followAccount` did: inserted the follow row, or found one already there. */
export type FollowWrite =
  | Readonly<{ kind: "Created"; follow: LocalFollow }>
  | Readonly<{ kind: "Existing" }>;

export const followAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
  targetLocked: boolean,
  options: FollowOptions = {},
): Promise<Result<FollowWrite, RepositoryError>> =>
  runD1(async () => {
    const follow = LocalFollow.initial(targetLocked);
    const inserted = await queryTyped(
      db,
      insertFollowOrIgnoreSql(newEntityId(), followerId, targetId, follow.kind, nowIso()),
      IdRow,
    );
    if (
      options.reblogs !== undefined ||
      options.notify !== undefined ||
      options.languages !== undefined
    ) {
      const existing = await queryTyped(db, findFollowKindSql(followerId, targetId), OptionsRow);
      const row = existing[0];
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
    return inserted.length > 0 ? { kind: "Created", follow } : { kind: "Existing" };
  });

export const unfollowAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteFollowSql(followerId, targetId));
  });

/**
 * Promote a `Pending` follow to `Accepted`, dated now: the follower counts
 * from the acceptance, as Mastodon creates the Follow then. Returns true when
 * a row moved.
 */
export const authorizeFollowRequest = async (
  db: D1Database,
  targetAccountId: string,
  followerAccountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      authorizeFollowRequestSql(targetAccountId, followerAccountId, nowIso()),
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

const TargetIdRow = z.object({ target_id: z.string(), id: z.string() });

/**
 * For each of `targetIds`, the accounts the viewer follows that also follow
 * it ("familiar followers"), ordered by username, at most `limit` each; a
 * target with none is left out.
 */
export const familiarFollowerIds = async (
  db: D1Database,
  viewerId: string,
  targetIds: ReadonlyArray<string>,
  limit: number,
): Promise<Result<ReadonlyMap<string, ReadonlyArray<string>>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listFamiliarFollowerIdsJsonSql(viewerId, jsonStringArray([...targetIds]), limit),
      TargetIdRow,
    );
    const byTarget = new Map<string, string[]>();
    for (const row of rows) {
      byTarget.set(row.target_id, [...(byTarget.get(row.target_id) ?? []), row.id]);
    }
    return byTarget;
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
    // The cursor sits in each branch so the page merges two index searches in
    // id order instead of sorting every follower.
    const { results } = await db
      .prepare(
        `SELECT id, follower_account_id AS account_id, NULL AS actor_uri FROM follows
         WHERE target_account_id = ? AND kind = 'Accepted' ${where}
         UNION ALL
         SELECT id, NULL, remote_actor_uri FROM remote_follows
         WHERE target_account_id = ? AND follow_kind = 'Accepted' ${where}
         ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, accountId, ...binds, limit)
      .all();
    return followEdges(results);
  });

/**
 * A page of the local followers of `accountId` who signed in at or after
 * `activeSince` (`User.signed_in_recently`), asked for a notification on
 * every new status, do not mute the account, and do not block or mute an
 * account or actor its note `statusId` mentions: up to `limit` of them,
 * after the follow `afterFollowId` (empty for the first page), in follow id
 * order.
 */
export const notifyingFollowersPage = async (
  db: D1Database,
  accountId: string,
  statusId: string,
  activeSince: string,
  afterFollowId: string,
  limit: number,
): Promise<Result<NotifyingFollowerPage, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listNotifyingFollowersSql(accountId, nowIso(), statusId, activeSince, afterFollowId, limit),
      NotifyingFollowerRow,
    );
    return {
      followers: rows.map((row) => ({
        accountId: row.follower_account_id,
        languages: parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr([]),
      })),
      next: rows.length === limit ? rows.at(-1)?.id : undefined,
    };
  });

/**
 * The local followers among `followerIds` that {@link notifyingFollowersPage}
 * would list, in one read: a direct note's addressed accounts.
 */
export const notifyingFollowersAmong = async (
  db: D1Database,
  accountId: string,
  statusId: string,
  activeSince: string,
  followerIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<NotifyingFollower>, RepositoryError>> =>
  runD1(async () => {
    if (followerIds.length === 0) {
      return [];
    }
    const rows = await queryTyped(
      db,
      listNotifyingFollowersAmongSql(
        accountId,
        nowIso(),
        statusId,
        activeSince,
        jsonStringArray(followerIds),
      ),
      NotifyingFollowerAmongRow,
    );
    return rows.map((row) => ({
      accountId: row.follower_account_id,
      languages: parseJsonColumn(z.array(z.string()), row.languages_json).unwrapOr([]),
    }));
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
 * Pending follows of `targetAccountId`, from local accounts and from remote
 * actors (as `r_…` ids), one list ordered by follow row id. As Mastodon's
 * `paginate_by_max_id`, the page reads `max_id` and `since_id`, not `min_id`.
 */
export const listFollowRequests = async (
  db: D1Database,
  targetAccountId: string,
  limit: number,
  cursor: MaxIdCursor = {},
): Promise<Result<FollowEdge[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment({
      maxId: cursor.maxId,
      sinceId: cursor.sinceId,
    });
    const { results } = await db
      .prepare(
        `SELECT id, follower_account_id AS account_id, NULL AS actor_uri FROM follows
         WHERE target_account_id = ? AND kind = 'Pending' ${where}
         UNION ALL
         SELECT id, NULL, remote_actor_uri FROM remote_follows
         WHERE target_account_id = ? AND remote_request_kind = 'Queued' ${where}
         ${order} LIMIT ?`,
      )
      .bind(targetAccountId, ...binds, targetAccountId, ...binds, limit)
      .all();
    return followEdges(results);
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
    // As in `listFollowers`: a merge of two index searches, not a sort.
    const { results } = await db
      .prepare(
        `SELECT id, target_account_id AS account_id, NULL AS actor_uri FROM follows
         WHERE follower_account_id = ? AND kind = 'Accepted' ${where}
         UNION ALL
         SELECT id, NULL, actor_uri FROM outbound_follows
         WHERE account_id = ? AND state = 'Accepted' ${where}
         ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, accountId, ...binds, limit)
      .all();
    return followEdges(results);
  });
