import {
  type GroupedNotificationEntry,
  type NewNotification,
  NotificationGroup,
  type NotificationGroupRepresentative,
  type NotificationGroupSummary,
  type NotificationGroupTarget,
  type NotificationPageDirection,
  type NotificationPageRange,
  type RemoteNotificationWithdrawal,
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
  listNotificationsAscending as listNotificationsAscendingSql,
  pageNotificationGroupsNewer as pageNotificationGroupsNewerSql,
  pageNotificationGroupsOlder as pageNotificationGroupsOlderSql,
  summarizeNotificationGroups as summarizeNotificationGroupsSql,
} from "./generated/prisma/sql";
import type { RemoteActorSearchHosts } from "./remote-actor-store";

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

/**
 * Record a notification from a remote actor about a status, unless the
 * account already holds one of the same kind from that actor about that
 * status, created at `since` or later (at any time by default). One
 * statement, so of two deliveries that record the same one at once, one
 * inserts. Resolves to the new id, or `undefined` when nothing was inserted.
 * The lookup reads `idx_notifications_account_status`.
 */
export const insertNotificationOnce = async (
  db: D1Database,
  input: NewNotification,
  since: string = "",
): Promise<Result<string | undefined, RepositoryError>> => {
  const id = newEntityId();
  return runD1(async () => {
    const written = await db
      .prepare(
        `INSERT INTO notifications
           (id, account_id, from_account_id, from_actor_uri, kind, status_id, created_at, target_account_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE NOT EXISTS (
           SELECT 1 FROM notifications
           WHERE account_id = ?2 AND status_id = ?6 AND kind = ?5 AND from_actor_uri = ?4
             AND created_at >= ?9
         )`,
      )
      .bind(
        id,
        input.accountId,
        input.fromAccountId,
        input.fromActorUri ?? null,
        input.kind,
        input.statusId ?? null,
        nowIso(),
        input.targetAccountId ?? null,
        since,
      )
      .run();
    return (written.meta.changes ?? 0) > 0 ? id : undefined;
  });
};

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
    const now = nowIso();
    const types = jsonStringArray(filters.types ?? []);
    const excludeTypes = jsonStringArray(filters.excludeTypes ?? []);
    const fromAccountId = filters.fromAccountId ?? "";
    const includeFiltered = filters.includeFiltered ? 1 : 0;
    const minId = filters.minId ?? "";
    const sinceId = filters.sinceId ?? "";
    // Mastodon's cursors: `min_id` pages newer from the oldest side; `since_id`
    // (which wins over `max_id`) newer and `max_id` older, both newest first.
    const query =
      minId.length > 0
        ? listNotificationsAscendingSql(
            accountId,
            now,
            limit,
            types,
            excludeTypes,
            fromAccountId,
            minId,
            includeFiltered,
            ...groupParameters(filters.group),
          )
        : listNotificationsSql(
            accountId,
            now,
            limit,
            types,
            excludeTypes,
            fromAccountId,
            sinceId,
            sinceId.length > 0 ? "" : (filters.maxId ?? ""),
            includeFiltered,
            ...groupParameters(filters.group),
          );
    const results = await queryTyped(db, query, NotificationQueryRowSchema);
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

const RepresentativeRowSchema = z.object({ id: z.string(), group_key: z.string() });

/**
 * The representatives of the first `limit` groups past the cursor, newest
 * first, as Mastodon's `paginate_groups`: `Older` reads down from `max_id`
 * (above `since_id`), `Newer` up from `min_id` (below `max_id`). Only
 * notifications from available senders count; `hosts` is the federation state
 * that hides a remote sender.
 */
export const pageNotificationGroups = async (
  db: D1Database,
  accountId: string,
  limit: number,
  filters: NotificationFilters,
  groupedTypes: ReadonlySet<string>,
  hosts: RemoteActorSearchHosts,
  direction: NotificationPageDirection,
): Promise<Result<ReadonlyArray<NotificationGroupRepresentative>, RepositoryError>> =>
  runD1(async () => {
    const page =
      direction === "Older" ? pageNotificationGroupsOlderSql : pageNotificationGroupsNewerSql;
    const rows = await queryTyped(
      db,
      page(
        accountId,
        nowIso(),
        limit,
        jsonStringArray(filters.types ?? []),
        jsonStringArray(filters.excludeTypes ?? []),
        filters.fromAccountId ?? "",
        filters.includeFiltered ? 1 : 0,
        jsonStringArray([...groupedTypes]),
        jsonStringArray([...hosts.suspended]),
        jsonStringArray([...hosts.allow]),
        filters.maxId ?? "",
        (direction === "Older" ? filters.sinceId : filters.minId) ?? "",
      ),
      RepresentativeRowSchema,
    );
    return rows.map((row) => ({ id: row.id, groupKey: row.group_key }));
  });

const NotificationGroupSummaryRowSchema = z.object({
  group_key: z.string(),
  id: z.string(),
  kind: z.string(),
  from_account_id: z.string(),
  status_id: z.string().nullable(),
  report_id: z.string().nullable(),
  severance_event_id: z.string().nullable(),
  created_at: z.string(),
  held: z.number(),
  notifications_count: z.number(),
  page_min_id: z.string(),
  sample_1: z.string().nullable(),
  sample_2: z.string().nullable(),
  sample_3: z.string().nullable(),
});

/** A group key as `summarizeNotificationGroups` reads it: `{key, id}` or `{key, type, target}`. */
const groupJson = (groupKey: string, target: NotificationGroupTarget) =>
  target.kind === "Notification"
    ? { key: groupKey, id: target.id }
    : { key: groupKey, type: target.type, target: target.target };

/**
 * Each group key's summary within `range`, as Mastodon's `load_groups_data`,
 * in one statement; a key that names nothing visible, or no group at all, has
 * no entry. Counts and samples take only available senders.
 */
export const summarizeNotificationGroups = async (
  db: D1Database,
  accountId: string,
  groupKeys: ReadonlyArray<string>,
  range: NotificationPageRange,
  hosts: RemoteActorSearchHosts,
): Promise<Result<ReadonlyMap<string, NotificationGroupSummary>, RepositoryError>> => {
  const groups = groupKeys.flatMap((groupKey) => {
    const target = NotificationGroup.target(groupKey);
    return target ? [groupJson(groupKey, target)] : [];
  });
  if (groups.length === 0) {
    return ok(new Map());
  }
  return runD1(async () => {
    const rows = await queryTyped(
      db,
      summarizeNotificationGroupsSql(
        accountId,
        nowIso(),
        JSON.stringify(groups),
        jsonStringArray([...hosts.suspended]),
        jsonStringArray([...hosts.allow]),
        range.upper?.id ?? "",
        range.upper?.inclusive ? 1 : 0,
        range.lower?.id ?? "",
        range.lower?.inclusive ? 1 : 0,
      ),
      NotificationGroupSummaryRowSchema,
    );
    return new Map(
      rows.map((row) => [
        row.group_key,
        {
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
          pageMinId: row.page_min_id,
          sampleAccountIds: [row.sample_1, row.sample_2, row.sample_3].flatMap((id) =>
            id === null ? [] : [id],
          ),
        },
      ]),
    );
  });
};

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
