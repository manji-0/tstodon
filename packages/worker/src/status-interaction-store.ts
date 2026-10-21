import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1, runD1Batch, sqlInJsonEach } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteBookmark as deleteBookmarkSql,
  deleteFavourite as deleteFavouriteSql,
  insertBookmarkOrIgnore as insertBookmarkOrIgnoreSql,
  insertFavouriteOrIgnore as insertFavouriteOrIgnoreSql,
} from "./generated/prisma/sql";

export const favouriteStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      insertFavouriteOrIgnoreSql(newEntityId(), accountId, statusId, nowIso()),
    );
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
  statusId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusBooster>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const local = await db
      .prepare(
        `SELECT id, account_id AS actor, created_at FROM favourites
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(statusId, ...binds, limit)
      .all<BoosterRow>();
    const remote = await db
      .prepare(
        `SELECT id, remote_actor_uri AS actor, created_at FROM remote_favourites
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(statusId, ...binds, limit)
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
  statusId: string,
  limit: number,
  cursor: IdCursor = {},
): Promise<Result<ReadonlyArray<StatusBooster>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const local = await db
      .prepare(
        `SELECT id, account_id AS actor, created_at FROM statuses
         WHERE kind = 'LocalReblog' AND reblog_of_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(statusId, ...binds, limit)
      .all<BoosterRow>();
    const remote = await db
      .prepare(
        `SELECT id, remote_actor_uri AS actor, created_at FROM remote_announces
         WHERE status_id = ? ${where} ${order} LIMIT ?`,
      )
      .bind(statusId, ...binds, limit)
      .all<BoosterRow>();
    return mergeStatusBoosters(
      local.results ?? [],
      remote.results ?? [],
      limit,
      cursorAscending(cursor),
    );
  });
