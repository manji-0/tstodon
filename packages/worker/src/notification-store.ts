import type {
  GroupedNotificationEntry,
  NewNotification,
  NotificationGroupSummary,
  NotificationGroupTarget,
  RemoteNotificationWithdrawal,
} from "@tstodon/domain";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { CountedRow, queryTyped, runTyped } from "./typed-sql";
import {
  clearNotifications as clearNotificationsSql,
  countUnreadNotifications as countUnreadNotificationsSql,
  deleteRemoteNotifications as deleteRemoteNotificationsSql,
  dismissNotification as dismissNotificationSql,
  dismissNotificationGroup as dismissNotificationGroupSql,
  findNotificationById as findNotificationByIdSql,
  findNotificationOwned as findNotificationOwnedSql,
  insertNotification as insertNotificationSql,
  listNotifications as listNotificationsSql,
  summarizeNotificationGroup as summarizeNotificationGroupSql,
} from "./generated/prisma/sql";

const PresentRow = z.object({ present: z.number() });
const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });

/** Held requests cascade with the withdrawn notifications. */
export const deleteRemoteNotifications = async (
  db: D1Database,
  input: RemoteNotificationWithdrawal,
): Promise<Result<number, RepositoryError>> =>
  runD1(
    async () =>
      (
        await queryTyped(
          db,
          deleteRemoteNotificationsSql(
            input.actorUri,
            jsonStringArray(input.kinds),
            input.statusId,
          ),
          CountedRow,
        )
      ).length,
  );

export const insertNotification = async (
  db: D1Database,
  input: NewNotification,
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
        input.targetAccountId ?? null,
        input.reportId ?? null,
        input.severanceEventId ?? null,
      ),
    );
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(id);
};

const NotificationQueryRowSchema = z.object({
  id: z.string().nullable(),
  account_id: z.string(),
  from_account_id: z.string(),
  kind: z.string(),
  status_id: z.string().nullable(),
  target_account_id: z.string().nullable(),
  report_id: z.string().nullable(),
  severance_event_id: z.string().nullable(),
  created_at: z.string(),
  held: z.number(),
});

/** A stored notification; `held` when the notification policy holds it. */
export type NotificationRow = Omit<z.infer<typeof NotificationQueryRowSchema>, "id" | "held"> & {
  id: string;
  held: boolean;
};

/** The fields of a row `NotificationGroup` groups on. */
export const groupedEntry = (row: NotificationRow): GroupedNotificationEntry => ({
  id: row.id,
  kind: row.kind,
  fromAccountId: row.from_account_id,
  statusId: row.status_id,
  reportId: row.report_id,
  severanceEventId: row.severance_event_id,
  createdAt: row.created_at,
  held: row.held,
});

export type NotificationFilters = Readonly<{
  types?: ReadonlyArray<string>;
  excludeTypes?: ReadonlyArray<string>;
  fromAccountId?: string | undefined;
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
  /** Include notifications held back by the notification policy. */
  includeFiltered?: boolean | undefined;
  /** Only the notifications a group key names. */
  group?: NotificationGroupTarget | undefined;
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

/**
 * The `notificationId`, `groupType`, `groupTarget` SQL parameters naming a
 * group key's notifications; all empty for no group.
 */
const groupParameters = (group: NotificationGroupTarget | undefined): [string, string, string] => {
  if (!group) {
    return ["", "", ""];
  }
  return group.kind === "Notification" ? [group.id, "", ""] : ["", group.type, group.target];
};

export const listNotifications = async (
  db: D1Database,
  accountId: string,
  limit: number,
  filters: NotificationFilters = {},
): Promise<Result<NotificationRow[], RepositoryError>> =>
  runD1(async () => {
    const cursor = notificationCursor(filters);
    const results = await queryTyped(
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
        ...groupParameters(filters.group),
      ),
      NotificationQueryRowSchema,
    );
    return results.map((row) => ({
      id: row.id ?? "",
      account_id: row.account_id,
      from_account_id: row.from_account_id,
      kind: row.kind,
      status_id: row.status_id,
      target_account_id: row.target_account_id,
      report_id: row.report_id,
      severance_event_id: row.severance_event_id,
      created_at: row.created_at,
      held: row.held !== 0,
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
    const rows = await queryTyped(
      db,
      findNotificationByIdSql(notificationId, accountId),
      NotificationQueryRowSchema,
    );
    const row = rows[0];
    if (!row || row.id === null) {
      return undefined;
    }
    return {
      id: row.id,
      account_id: row.account_id,
      from_account_id: row.from_account_id,
      kind: row.kind,
      status_id: row.status_id,
      target_account_id: row.target_account_id,
      report_id: row.report_id,
      severance_event_id: row.severance_event_id,
      created_at: row.created_at,
      held: row.held !== 0,
    };
  });

export const dismissNotification = async (
  db: D1Database,
  accountId: string,
  notificationId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const owned = await queryTyped(
      db,
      findNotificationOwnedSql(accountId, notificationId),
      PresentRow,
    );
    if (owned.length === 0) {
      return false;
    }
    await runTyped(db, dismissNotificationSql(accountId, notificationId, nowIso()));
    return true;
  });

/** Hide every notification a group key names, in one statement whatever the group's size. */
export const dismissNotificationGroup = async (
  db: D1Database,
  accountId: string,
  group: NotificationGroupTarget,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, dismissNotificationGroupSql(accountId, nowIso(), ...groupParameters(group)));
  });

const NotificationGroupSummaryRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  from_account_id: z.string(),
  status_id: z.string().nullable(),
  report_id: z.string().nullable(),
  severance_event_id: z.string().nullable(),
  created_at: z.string(),
  held: z.number(),
  notifications_count: z.number(),
  oldest_id: z.string(),
});

/** A group key's count, oldest id and newest notification; undefined when it names nothing visible. */
export const summarizeNotificationGroup = async (
  db: D1Database,
  accountId: string,
  group: NotificationGroupTarget,
): Promise<Result<NotificationGroupSummary | undefined, RepositoryError>> =>
  runD1(async () => {
    const [row] = await queryTyped(
      db,
      summarizeNotificationGroupSql(accountId, nowIso(), ...groupParameters(group)),
      NotificationGroupSummaryRowSchema,
    );
    if (!row) {
      return undefined;
    }
    return {
      newest: {
        id: row.id,
        kind: row.kind,
        fromAccountId: row.from_account_id,
        statusId: row.status_id,
        reportId: row.report_id,
        severanceEventId: row.severance_event_id,
        createdAt: row.created_at,
        held: row.held !== 0,
      },
      notificationsCount: row.notifications_count,
      oldestId: row.oldest_id,
    };
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
    const rows = await queryTyped(
      db,
      countUnreadNotificationsSql(accountId, markerId ?? "", nowIso()),
      CountRow,
    );
    return Number(rows[0]?.count ?? 0);
  });
