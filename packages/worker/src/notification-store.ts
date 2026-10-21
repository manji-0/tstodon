import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { queryTyped, runTyped } from "./typed-sql";
import {
  clearNotifications as clearNotificationsSql,
  countUnreadNotifications as countUnreadNotificationsSql,
  deleteRemoteNotifications as deleteRemoteNotificationsSql,
  dismissNotification as dismissNotificationSql,
  findNotificationById as findNotificationByIdSql,
  findNotificationOwned as findNotificationOwnedSql,
  insertNotification as insertNotificationSql,
  listNotifications as listNotificationsSql,
} from "./generated/prisma/sql";

/**
 * Withdraw what a remote actor's activity notified, when the activity is
 * undone or its note deleted: its notifications of `kinds`, narrowed to one
 * recipient and/or status when given. Held requests cascade with them.
 */
export const deleteRemoteNotifications = async (
  db: D1Database,
  input: Readonly<{
    actorUri: string;
    kinds: ReadonlyArray<string>;
    accountId?: string;
    statusId?: string;
  }>,
): Promise<Result<number, RepositoryError>> =>
  runD1(
    async () =>
      (
        await queryTyped(
          db,
          deleteRemoteNotificationsSql(
            input.actorUri,
            jsonStringArray(input.kinds),
            input.accountId ?? "",
            input.statusId ?? "",
          ),
        )
      ).length,
  );

export const insertNotification = async (
  db: D1Database,
  input: {
    accountId: string;
    fromAccountId: string;
    /** The sender's actor URI when it is a remote account. */
    fromActorUri?: string;
    kind: string;
    statusId?: string;
  },
): Promise<Result<string, RepositoryError>> => {
  const id = newEntityId();
  const written = await runD1(async () => {
    await runTyped(
      db,
      insertNotificationSql(
        id,
        input.accountId,
        input.fromAccountId,
        input.fromActorUri ?? null,
        input.kind,
        input.statusId ?? null,
        nowIso(),
      ),
    );
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(id);
};

export type NotificationRow = {
  id: string;
  account_id: string;
  from_account_id: string;
  kind: string;
  status_id: string | null;
  created_at: string;
};

export type NotificationFilters = Readonly<{
  types?: ReadonlyArray<string>;
  excludeTypes?: ReadonlyArray<string>;
  fromAccountId?: string | undefined;
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
  /** Include notifications held back by the notification policy. */
  includeFiltered?: boolean | undefined;
}>;

/**
 * Mastodon's notification cursors: `max_id` pages older, `since_id` newer
 * (newest first), `min_id` newer from the oldest side.
 */
const notificationCursor = (
  filters: NotificationFilters,
): Readonly<{ id: string; greaterThan: number; ascending: number }> => {
  const minId = filters.minId ?? "";
  if (minId.length > 0) {
    return { id: minId, greaterThan: 1, ascending: 1 };
  }
  const sinceId = filters.sinceId ?? "";
  if (sinceId.length > 0) {
    return { id: sinceId, greaterThan: 1, ascending: 0 };
  }
  return { id: filters.maxId ?? "", greaterThan: 0, ascending: 0 };
};

export const listNotifications = async (
  db: D1Database,
  accountId: string,
  limit: number,
  filters: NotificationFilters = {},
): Promise<Result<NotificationRow[], RepositoryError>> =>
  runD1(async () => {
    const cursor = notificationCursor(filters);
    const results = await queryTyped<NotificationRow>(
      db,
      listNotificationsSql(
        accountId,
        nowIso(),
        limit,
        jsonStringArray(filters.types ?? []),
        jsonStringArray(filters.excludeTypes ?? []),
        filters.fromAccountId ?? "",
        cursor.id,
        cursor.greaterThan,
        cursor.ascending,
        filters.includeFiltered ? 1 : 0,
      ),
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

/** Hide one notification for an account. False when the row is not theirs. */

/** One notification of the account, by id. */
export const findNotificationById = async (
  db: D1Database,
  accountId: string,
  notificationId: string,
): Promise<Result<NotificationRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<NotificationRow>(
      db,
      findNotificationByIdSql(notificationId, accountId),
    );
    const row = rows[0];
    if (!row || row.id === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      account_id: row.account_id,
      from_account_id: row.from_account_id,
      kind: row.kind,
      status_id: row.status_id,
      created_at: row.created_at,
    };
  });

export const dismissNotification = async (
  db: D1Database,
  accountId: string,
  notificationId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const owned = await queryTyped<{ present: number }>(
      db,
      findNotificationOwnedSql(accountId, notificationId),
    );
    if (owned.length === 0) {
      return false;
    }
    await runTyped(db, dismissNotificationSql(accountId, notificationId, nowIso()));
    return true;
  });

/** Hide every current notification for an account by moving the clear marker. */
export const clearNotifications = async (
  db: D1Database,
  accountId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, clearNotificationsSql(accountId, nowIso()));
  });

/** Count visible notifications newer than the notifications marker. */
export const countUnreadNotifications = async (
  db: D1Database,
  accountId: string,
  markerId: string | undefined,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(
      db,
      countUnreadNotificationsSql(accountId, markerId ?? "", nowIso()),
    );
    return Number(rows[0]?.count ?? 0);
  });
