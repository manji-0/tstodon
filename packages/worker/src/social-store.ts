import { FollowRequest, LocalFollow } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { chunkArray, runD1, runD1Batch, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";

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
    // Happy path: one INSERT. Only SELECT when the unique pair already exists.
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO follows (id, follower_account_id, target_account_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(newEntityId(), followerId, targetId, followKind, nowIso())
      .run();
    if ((inserted.meta.changes ?? 0) > 0) {
      return state;
    }
    const existing = await db
      .prepare(`SELECT kind FROM follows WHERE follower_account_id = ? AND target_account_id = ?`)
      .bind(followerId, targetId)
      .first<{ kind: string }>();
    return FollowRequest.parse({
      kind: "LocalFollower",
      targetLocked,
      follow: existing?.kind === "Accepted" ? LocalFollow.Accepted : LocalFollow.Pending,
    }).unwrapOr(state);
  });

export const unfollowAccount = async (
  db: D1Database,
  followerId: string,
  targetId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(`DELETE FROM follows WHERE follower_account_id = ? AND target_account_id = ?`)
      .bind(followerId, targetId)
      .run();
  });

export const relationshipFlags = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<
  Result<Readonly<{ following: boolean; followedBy: boolean; requested: boolean }>, RepositoryError>
> => {
  const followSelect = db.prepare(
    `SELECT kind FROM follows WHERE follower_account_id = ? AND target_account_id = ?`,
  );
  const batched = await runD1Batch(db, [
    followSelect.bind(viewerId, targetId),
    followSelect.bind(targetId, viewerId),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  const outgoing = batched.value[0]?.results?.[0] as { kind: string } | undefined;
  const incoming = batched.value[1]?.results?.[0] as { kind: string } | undefined;
  return ok({
    following: outgoing?.kind === "Accepted",
    followedBy: incoming?.kind === "Accepted",
    requested: outgoing?.kind === "Pending",
  });
};

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

  for (const chunk of chunkArray(unique)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `SELECT status_id, COUNT(*) AS count FROM favourites
           WHERE status_id IN (${placeholders}) GROUP BY status_id`,
        )
        .bind(...chunk),
      db
        .prepare(
          `SELECT reblog_of_id AS status_id, COUNT(*) AS count FROM statuses
           WHERE kind = 'LocalReblog' AND reblog_of_id IN (${placeholders})
           GROUP BY reblog_of_id`,
        )
        .bind(...chunk),
      db
        .prepare(
          `SELECT status_id, COUNT(*) AS count FROM remote_favourites
           WHERE status_id IN (${placeholders}) GROUP BY status_id`,
        )
        .bind(...chunk),
      db
        .prepare(
          `SELECT status_id, COUNT(*) AS count FROM remote_announces
           WHERE status_id IN (${placeholders}) GROUP BY status_id`,
        )
        .bind(...chunk),
    ];
    if (viewerId) {
      statements.push(
        db
          .prepare(
            `SELECT status_id FROM favourites
             WHERE account_id = ? AND status_id IN (${placeholders})`,
          )
          .bind(viewerId, ...chunk),
        db
          .prepare(
            `SELECT reblog_of_id AS status_id FROM statuses
             WHERE kind = 'LocalReblog' AND account_id = ? AND reblog_of_id IN (${placeholders})`,
          )
          .bind(viewerId, ...chunk),
        db
          .prepare(
            `SELECT status_id FROM bookmarks
             WHERE account_id = ? AND status_id IN (${placeholders})`,
          )
          .bind(viewerId, ...chunk),
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
  }
  return ok(counts);
};

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
