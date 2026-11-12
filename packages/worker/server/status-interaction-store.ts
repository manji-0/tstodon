import { StatusTarget, type StatusTargetValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  jsonStringArray,
  parseRows,
  type RepositoryError,
  runD1,
  runD1Batch,
  sqlInJsonEach,
} from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { statusTargetColumns } from "./status-store";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  deleteBookmark as deleteBookmarkSql,
  deleteFavourite as deleteFavouriteSql,
  insertBookmarkOrIgnore as insertBookmarkOrIgnoreSql,
  insertFavouriteOrIgnore as insertFavouriteOrIgnoreSql,
  statusStatsByIdsJson as statusStatsByIdsJsonSql,
} from "./generated/prisma/sql";

const IdRow = z.object({ id: z.string() });
const AccountIdRow = z.object({ account_id: z.string() });

/** Favourite a status; resolves to the new favourite's id, or nothing when it was already one. */
export const favouriteStatus = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      insertFavouriteOrIgnoreSql(
        newEntityId(),
        accountId,
        ...statusTargetColumns(target),
        nowIso(),
      ),
      IdRow,
    );
    return rows[0]?.id;
  });

/** Drop a favourite; resolves to its id, or nothing when there was none. */
export const unfavouriteStatus = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      deleteFavouriteSql(accountId, ...statusTargetColumns(target)),
      IdRow,
    );
    return rows[0]?.id;
  });

export const bookmarkStatus = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertBookmarkOrIgnoreSql(newEntityId(), accountId, ...statusTargetColumns(target), nowIso()),
    );
  });

/** Drop a bookmark; resolves to its id, or nothing when there was none. */
export const unbookmarkStatus = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      deleteBookmarkSql(accountId, ...statusTargetColumns(target)),
      IdRow,
    );
    return rows[0]?.id;
  });

const TargetRowSchema = z.object({
  local_status_id: z.string().nullable(),
  remote_status_id: z.string().nullable(),
});

/** The statuses an account favourited or bookmarked, by status id under the cursor. */
const listEngagedTargets = async (
  db: D1Database,
  table: "favourites" | "bookmarks",
  accountId: string,
  limit: number,
  cursor: IdCursor,
): Promise<Result<ReadonlyArray<StatusTargetValue>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT local_status_id, remote_status_id FROM (
           SELECT COALESCE(local_status_id, remote_status_id) AS id, local_status_id, remote_status_id
           FROM ${table} WHERE account_id = ?
         ) WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return parseRows(TargetRowSchema, results).flatMap((row) => {
      const target = StatusTarget.parse(
        row.local_status_id
          ? { kind: "LocalStatus", statusId: row.local_status_id }
          : { kind: "RemoteStatus", statusId: row.remote_status_id },
      );
      return target.isOk() ? [target.value] : [];
    });
  });

/** The account's favourites, local and remote statuses alike, paged by status id. */
export const listFavouritedTargets = (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusTargetValue>, RepositoryError>> =>
  listEngagedTargets(db, "favourites", accountId, limit, cursor);

/** The account's bookmarks, local and remote statuses alike, paged by status id. */
export const listBookmarkedTargets = (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusTargetValue>, RepositoryError>> =>
  listEngagedTargets(db, "bookmarks", accountId, limit, cursor);

export type StatusInteractionCounts = Readonly<{
  favourites: number;
  reblogs: number;
  quotes: number;
  replies: number;
  favourited: boolean;
  reblogged: boolean;
  bookmarked: boolean;
}>;

export const NO_STATUS_INTERACTIONS: StatusInteractionCounts = {
  favourites: 0,
  reblogs: 0,
  quotes: 0,
  replies: 0,
  favourited: false,
  reblogged: false,
  bookmarked: false,
};

const StatusStatsRow = z.object({
  status_id: z.string(),
  favourites_count: z.number(),
  reblogs_count: z.number(),
  quotes_count: z.number(),
  replies_count: z.number(),
});

/**
 * The counters triggers keep in `status_stats` (migration 0135) for local and
 * remote statuses alike, and with a viewer whether they favourited, boosted
 * or bookmarked each.
 */
export const statusInteractionCountsByIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  viewerId: string | undefined,
): Promise<Result<Map<string, StatusInteractionCounts>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, StatusInteractionCounts>());
  }

  const idsJson = jsonStringArray(unique);
  const inList = sqlInJsonEach();
  const statements: D1PreparedStatement[] = [d1PrepareTyped(db, statusStatsByIdsJsonSql(idsJson))];
  if (viewerId) {
    // One equality branch per target column, so each reads the viewer's
    // (account, status) index entries instead of every row the viewer has.
    const viewerTargets = (table: "favourites" | "bookmarks") =>
      db
        .prepare(
          `SELECT local_status_id AS status_id FROM ${table}
           WHERE account_id = ? AND local_status_id ${inList}
           UNION ALL
           SELECT remote_status_id AS status_id FROM ${table}
           WHERE account_id = ? AND remote_status_id ${inList}`,
        )
        .bind(viewerId, idsJson, viewerId, idsJson);
    statements.push(
      viewerTargets("favourites"),
      db
        .prepare(
          `SELECT reblog_of_id AS status_id FROM statuses
           WHERE kind = 'LocalReblog' AND account_id = ? AND reblog_of_id ${inList}
           UNION ALL
           SELECT reblog_of_remote_id AS status_id FROM statuses
           WHERE kind = 'LocalReblog' AND account_id = ? AND reblog_of_remote_id ${inList}`,
        )
        .bind(viewerId, idsJson, viewerId, idsJson),
      viewerTargets("bookmarks"),
    );
  }
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const stats = new Map(
    parseRows(StatusStatsRow, batched.value[0]?.results).map((row) => [row.status_id, row]),
  );
  const viewerSet = (index: number): ReadonlySet<string> =>
    new Set(
      viewerId
        ? parseRows(z.object({ status_id: z.string() }), batched.value[index]?.results).map(
            (row) => row.status_id,
          )
        : [],
    );
  const favourited = viewerSet(1);
  const reblogged = viewerSet(2);
  const bookmarked = viewerSet(3);
  return ok(
    new Map(
      unique.map((id): [string, StatusInteractionCounts] => [
        id,
        {
          favourites: stats.get(id)?.favourites_count ?? 0,
          reblogs: stats.get(id)?.reblogs_count ?? 0,
          quotes: stats.get(id)?.quotes_count ?? 0,
          replies: stats.get(id)?.replies_count ?? 0,
          favourited: favourited.has(id),
          reblogged: reblogged.has(id),
          bookmarked: bookmarked.has(id),
        },
      ]),
    ),
  );
};

/**
 * An account that favourited or boosted a status: a local account, or a remote
 * actor whose `Like`/`Announce` was stored.
 */
export type StatusBooster =
  | Readonly<{ kind: "Local"; id: string; accountId: string; createdAt: string }>
  | Readonly<{ kind: "Remote"; id: string; actorUri: string; createdAt: string }>;

const BoosterRow = z.object({ id: z.string(), actor: z.string(), created_at: z.string() });
type BoosterRow = z.infer<typeof BoosterRow>;

/**
 * Merge both halves of an engagement count around the cursor. Each side is
 * read with the same id condition, so the global page is always inside the
 * union of the two sides.
 */
const mergeStatusBoosters = (
  local: ReadonlyArray<BoosterRow>,
  remote: ReadonlyArray<BoosterRow>,
  limit: number,
  ascending: boolean,
): ReadonlyArray<StatusBooster> =>
  [
    ...local.map((row) => ({ ...row, kind: "Local" as const })),
    ...remote.map((row) => ({ ...row, kind: "Remote" as const })),
  ]
    .toSorted((left, right) =>
      ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id),
    )
    .slice(0, limit)
    .map((row) =>
      row.kind === "Local"
        ? { kind: row.kind, id: row.id, accountId: row.actor, createdAt: row.created_at }
        : { kind: row.kind, id: row.id, actorUri: row.actor, createdAt: row.created_at },
    );

/** True when `min_id` asks for the oldest-first side of the page. */
const cursorAscending = (cursor: IdCursor): boolean => (cursor.minId ?? "").length > 0;

export const listStatusFavouritedBy = async (
  db: D1Database,
  target: StatusTargetValue,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusBooster>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const local = await db
      .prepare(
        `SELECT id, account_id AS actor, created_at FROM favourites
         WHERE (local_status_id = ? OR remote_status_id = ?) ${where} ${order} LIMIT ?`,
      )
      .bind(...statusTargetColumns(target), ...binds, limit)
      .all();
    const remote = await db
      .prepare(
        `SELECT id, remote_actor_uri AS actor, created_at FROM remote_favourites
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(target.statusId, ...binds, limit)
      .all();
    return mergeStatusBoosters(
      parseRows(BoosterRow, local.results),
      parseRows(BoosterRow, remote.results),
      limit,
      cursorAscending(cursor),
    );
  });

export const listStatusRebloggedBy = async (
  db: D1Database,
  target: StatusTargetValue,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusBooster>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const local = await db
      .prepare(
        `SELECT id, account_id AS actor, created_at FROM statuses
         WHERE kind = 'LocalReblog' AND (reblog_of_id = ? OR reblog_of_remote_id = ?)
         ${where} ${order} LIMIT ?`,
      )
      .bind(...statusTargetColumns(target), ...binds, limit)
      .all();
    const remote = await db
      .prepare(
        `SELECT id, remote_actor_uri AS actor, created_at FROM remote_announces
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(target.statusId, ...binds, limit)
      .all();
    return mergeStatusBoosters(
      parseRows(BoosterRow, local.results),
      parseRows(BoosterRow, remote.results),
      limit,
      cursorAscending(cursor),
    );
  });

/** Every local account that currently boosts the target, for notifying them when it changes. */
export const listLocalBoosterAccountIds = async (
  db: D1Database,
  target: StatusTargetValue,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT DISTINCT account_id FROM statuses
         WHERE kind = 'LocalReblog' AND (reblog_of_id = ? OR reblog_of_remote_id = ?)`,
      )
      .bind(...statusTargetColumns(target))
      .all();
    return parseRows(AccountIdRow, rows.results).map((row) => row.account_id);
  });
