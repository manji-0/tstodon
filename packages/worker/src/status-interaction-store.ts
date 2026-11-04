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
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteBookmark as deleteBookmarkSql,
  deleteFavourite as deleteFavouriteSql,
  insertBookmarkOrIgnore as insertBookmarkOrIgnoreSql,
  insertFavouriteOrIgnore as insertFavouriteOrIgnoreSql,
} from "./generated/prisma/sql";

/** Favourite a status; resolves to the new favourite's id, or nothing when it was already one. */
export const favouriteStatus = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      insertFavouriteOrIgnoreSql(
        newEntityId(),
        accountId,
        ...statusTargetColumns(target),
        nowIso(),
      ),
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
    const rows = await queryTyped<{ id: string }>(
      db,
      deleteFavouriteSql(accountId, ...statusTargetColumns(target)),
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

export const unbookmarkStatus = async (
  db: D1Database,
  accountId: string,
  target: StatusTargetValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteBookmarkSql(accountId, ...statusTargetColumns(target)));
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
  favourited: boolean;
  reblogged: boolean;
  bookmarked: boolean;
}>;

export const NO_STATUS_INTERACTIONS: StatusInteractionCounts = {
  favourites: 0,
  reblogs: 0,
  favourited: false,
  reblogged: false,
  bookmarked: false,
};

export const statusInteractionCounts = async (
  db: D1Database,
  statusId: string,
  viewerId: string | undefined,
): Promise<Result<StatusInteractionCounts, RepositoryError>> => {
  const bulk = await statusInteractionCountsByIds(db, [statusId], viewerId);
  if (bulk.isErr()) {
    return err(bulk.error);
  }
  return ok(bulk.value.get(statusId) ?? NO_STATUS_INTERACTIONS);
};

export const statusInteractionCountsByIds = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  viewerId: string | undefined,
): Promise<Result<Map<string, StatusInteractionCounts>, RepositoryError>> => {
  const unique = [...new Set(statusIds.filter((id) => id.length > 0))];
  const counts = new Map<string, StatusInteractionCounts>();
  for (const id of unique) {
    counts.set(id, NO_STATUS_INTERACTIONS);
  }
  if (unique.length === 0) {
    return ok(counts);
  }

  const bump = (statusId: string, patch: Partial<StatusInteractionCounts>): void => {
    const current = counts.get(statusId) ?? NO_STATUS_INTERACTIONS;
    counts.set(statusId, { ...current, ...patch });
  };

  const idsJson = jsonStringArray(unique);
  const inList = sqlInJsonEach();
  // Ids are shared by local and remote statuses, so each list matches either column.
  const targetOf = `COALESCE(local_status_id, remote_status_id)`;
  const targetIn = `(local_status_id ${inList} OR remote_status_id ${inList})`;
  const reblogOf = `COALESCE(reblog_of_id, reblog_of_remote_id)`;
  const reblogIn = `(reblog_of_id ${inList} OR reblog_of_remote_id ${inList})`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT ${targetOf} AS status_id, COUNT(*) AS count FROM favourites
         WHERE ${targetIn} GROUP BY ${targetOf}`,
      )
      .bind(idsJson, idsJson),
    db
      .prepare(
        `SELECT ${reblogOf} AS status_id, COUNT(*) AS count FROM statuses
         WHERE kind = 'LocalReblog' AND ${reblogIn}
         GROUP BY ${reblogOf}`,
      )
      .bind(idsJson, idsJson),
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
          `SELECT ${targetOf} AS status_id FROM favourites
           WHERE account_id = ? AND ${targetIn}`,
        )
        .bind(viewerId, idsJson, idsJson),
      db
        .prepare(
          `SELECT ${reblogOf} AS status_id FROM statuses
           WHERE kind = 'LocalReblog' AND account_id = ? AND ${reblogIn}`,
        )
        .bind(viewerId, idsJson, idsJson),
      db
        .prepare(
          `SELECT ${targetOf} AS status_id FROM bookmarks
           WHERE account_id = ? AND ${targetIn}`,
        )
        .bind(viewerId, idsJson, idsJson),
    );
  }
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const countRows = (index: number) =>
    parseRows(
      z.object({ status_id: z.string(), count: z.number() }),
      batched.value[index]?.results,
    );
  const idRows = (index: number) =>
    parseRows(z.object({ status_id: z.string() }), batched.value[index]?.results);

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

/**
 * An account that favourited or boosted a status: a local account, or a remote
 * actor whose `Like`/`Announce` was stored.
 */
export type StatusBooster =
  | Readonly<{ kind: "Local"; id: string; accountId: string; createdAt: string }>
  | Readonly<{ kind: "Remote"; id: string; actorUri: string; createdAt: string }>;

type BoosterRow = Readonly<{ id: string; actor: string; created_at: string }>;

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
      .all<BoosterRow>();
    const remote = await db
      .prepare(
        `SELECT id, remote_actor_uri AS actor, created_at FROM remote_favourites
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(target.statusId, ...binds, limit)
      .all<BoosterRow>();
    return mergeStatusBoosters(
      local.results ?? [],
      remote.results ?? [],
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
      .all<BoosterRow>();
    const remote = await db
      .prepare(
        `SELECT id, remote_actor_uri AS actor, created_at FROM remote_announces
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(target.statusId, ...binds, limit)
      .all<BoosterRow>();
    return mergeStatusBoosters(
      local.results ?? [],
      remote.results ?? [],
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
      .all<{ account_id: string }>();
    return (rows.results ?? []).map((row) => row.account_id);
  });
