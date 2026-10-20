import { schemaResult } from "@tstodon/core";
import { nowIso } from "./clock";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { newEntityId } from "./ids";
import {
  countNotificationRequests as countNotificationRequestsSql,
  deleteNotificationRequests as deleteNotificationRequestsSql,
  findNotificationPolicy as findNotificationPolicySql,
  hasNotificationAcceptance as hasNotificationAcceptanceSql,
  insertNotificationAcceptance as insertNotificationAcceptanceSql,
  insertNotificationRequest as insertNotificationRequestSql,
  upsertNotificationPolicy as upsertNotificationPolicySql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/** Mastodon's `accept` / `filter` / `drop` handling for a notification category. */
export const NotificationPolicyActionSchema = z.union([
  z.literal("accept"),
  z.literal("filter"),
  z.literal("drop"),
]);

export type NotificationPolicyAction = z.infer<typeof NotificationPolicyActionSchema>;

export type NotificationPolicy = Readonly<{
  forNotFollowing: NotificationPolicyAction;
  forNotFollowers: NotificationPolicyAction;
  forNewAccounts: NotificationPolicyAction;
  forPrivateMentions: NotificationPolicyAction;
  forLimitedAccounts: NotificationPolicyAction;
}>;

/** Mastodon's defaults: private mentions are dropped, limited accounts filtered. */
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  forNotFollowing: "accept",
  forNotFollowers: "accept",
  forNewAccounts: "accept",
  forPrivateMentions: "drop",
  forLimitedAccounts: "filter",
};

const parseAction = schemaResult(NotificationPolicyActionSchema);

const PolicyRowSchema = z.object({
  for_not_following: z.string(),
  for_not_followers: z.string(),
  for_new_accounts: z.string(),
  for_private_mentions: z.string(),
  for_limited_accounts: z.string(),
});

const action = (raw: string, fallback: NotificationPolicyAction): NotificationPolicyAction => {
  const parsed = parseAction(raw);
  return parsed.isOk() ? parsed.value : fallback;
};

export const findNotificationPolicy = async (
  db: D1Database,
  accountId: string,
): Promise<Result<NotificationPolicy, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findNotificationPolicySql(accountId));
    const row = schemaResult(PolicyRowSchema)(rows[0]);
    if (row.isErr()) {
      return { ...DEFAULT_NOTIFICATION_POLICY };
    }
    return {
      forNotFollowing: action(
        row.value.for_not_following,
        DEFAULT_NOTIFICATION_POLICY.forNotFollowing,
      ),
      forNotFollowers: action(
        row.value.for_not_followers,
        DEFAULT_NOTIFICATION_POLICY.forNotFollowers,
      ),
      forNewAccounts: action(
        row.value.for_new_accounts,
        DEFAULT_NOTIFICATION_POLICY.forNewAccounts,
      ),
      forPrivateMentions: action(
        row.value.for_private_mentions,
        DEFAULT_NOTIFICATION_POLICY.forPrivateMentions,
      ),
      forLimitedAccounts: action(
        row.value.for_limited_accounts,
        DEFAULT_NOTIFICATION_POLICY.forLimitedAccounts,
      ),
    };
  });

export const saveNotificationPolicy = async (
  db: D1Database,
  accountId: string,
  policy: NotificationPolicy,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(
      db,
      upsertNotificationPolicySql(
        accountId,
        policy.forNotFollowing,
        policy.forNotFollowers,
        policy.forNewAccounts,
        policy.forPrivateMentions,
        policy.forLimitedAccounts,
        nowIso(),
      ),
    );
  });
  return written.map(() => undefined);
};

export type NotificationRequest = Readonly<{
  /** The stable request id the document exposes and the endpoints take. */
  id: string;
  fromAccountId: string;
  notificationsCount: number;
  /** The status behind the held notifications, when there is one. */
  statusId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

const RequestRowSchema = z.object({
  id: z.string().min(1),
  from_account_id: z.string().min(1),
  notifications_count: z.number(),
  status_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const requestFromRow = (raw: unknown): NotificationRequest | undefined => {
  const row = schemaResult(RequestRowSchema)(raw);
  return row.isOk()
    ? {
        id: row.value.id,
        fromAccountId: row.value.from_account_id,
        notificationsCount: row.value.notifications_count,
        statusId: row.value.status_id,
        createdAt: row.value.created_at,
        updatedAt: row.value.updated_at,
      }
    : undefined;
};

const REQUEST_SELECT = `SELECT g.id AS id, g.from_account_id, COUNT(n.notification_id) AS notifications_count,
       MAX(n.status_id) AS status_id, MIN(n.created_at) AS created_at, MAX(n.created_at) AS updated_at
  FROM notification_request_groups g
  JOIN notification_requests n
    ON n.account_id = g.account_id AND n.from_account_id = g.from_account_id`;

/** Held-back notifications grouped by sender, newest request first. */
/** Mastodon returns at most 80 requests per page, 40 by default. */
export const listNotificationRequests = async (
  db: D1Database,
  accountId: string,
  limit: number = 40,
  cursor: IdCursor = {},
): Promise<Result<NotificationRequest[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `${REQUEST_SELECT}
         WHERE g.account_id = ? ${where}
         GROUP BY g.id ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return (results ?? []).flatMap((raw) => {
      const request = requestFromRow(raw);
      return request ? [request] : [];
    });
  });

/**
 * Find a request by its own id. The sender's account id is accepted too, so
 * ids handed out before the request groups existed keep working.
 */
export const findNotificationRequest = async (
  db: D1Database,
  accountId: string,
  id: string,
): Promise<Result<NotificationRequest | undefined, RepositoryError>> =>
  runD1(async () => {
    const byId = await db
      .prepare(`${REQUEST_SELECT} WHERE g.account_id = ? AND g.id = ? GROUP BY g.id`)
      .bind(accountId, id)
      .all();
    const found = requestFromRow(byId.results?.[0]);
    if (found) {
      return found;
    }
    const bySender = await db
      .prepare(`${REQUEST_SELECT} WHERE g.account_id = ? AND g.from_account_id = ? GROUP BY g.id`)
      .bind(accountId, id)
      .all();
    return requestFromRow(bySender.results?.[0]);
  });

export const countNotificationRequests = async (
  db: D1Database,
  accountId: string,
): Promise<Result<Readonly<{ requests: number; notifications: number }>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ requests: number; notifications: number }>(
      db,
      countNotificationRequestsSql(accountId),
    );
    return {
      requests: Number(rows[0]?.requests ?? 0),
      notifications: Number(rows[0]?.notifications ?? 0),
    };
  });

export const holdNotification = async (
  db: D1Database,
  notificationId: string,
  accountId: string,
  fromAccountId: string,
  statusId: string | undefined,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    const createdAt = nowIso();
    // The group is created with the first held notification and keeps its id
    // from then on, so a client can hold on to the request id.
    await db
      .prepare(
        `INSERT INTO notification_request_groups (id, account_id, from_account_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, from_account_id) DO NOTHING`,
      )
      .bind(newEntityId(), accountId, fromAccountId, createdAt)
      .run();
    await runTyped(
      db,
      insertNotificationRequestSql(
        notificationId,
        accountId,
        fromAccountId,
        statusId ?? null,
        createdAt,
      ),
    );
  });
  return written.map(() => undefined);
};

/** Drop a request group once its last held notification is gone. */
const deleteEmptyRequestGroup = async (
  db: D1Database,
  accountId: string,
  fromAccountId: string,
): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM notification_request_groups
       WHERE account_id = ? AND from_account_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM notification_requests n
           WHERE n.account_id = notification_request_groups.account_id
             AND n.from_account_id = notification_request_groups.from_account_id
         )`,
    )
    .bind(accountId, fromAccountId)
    .run();
};

/** Accept a sender: their held notifications merge back into the list. */
export const acceptNotificationRequests = async (
  db: D1Database,
  accountId: string,
  fromAccountId: string,
): Promise<Result<number, RepositoryError>> => {
  const released = await runD1(async () => {
    const rows = await queryTyped<{ notification_id: string }>(
      db,
      deleteNotificationRequestsSql(accountId, fromAccountId),
    );
    await runTyped(db, insertNotificationAcceptanceSql(accountId, fromAccountId, nowIso()));
    await deleteEmptyRequestGroup(db, accountId, fromAccountId);
    return rows.length;
  });
  return released;
};

/** Dismiss a sender: their held notifications are discarded. */
export const dismissNotificationRequests = async (
  db: D1Database,
  accountId: string,
  fromAccountId: string,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> => {
  const dismissed = await runD1(async () => {
    const rows = await queryTyped<{ notification_id: string }>(
      db,
      deleteNotificationRequestsSql(accountId, fromAccountId),
    );
    await deleteEmptyRequestGroup(db, accountId, fromAccountId);
    return rows.map((row) => row.notification_id);
  });
  if (dismissed.isErr()) {
    return err(dismissed.error);
  }
  return ok(dismissed.value);
};

export const isSenderAccepted = async (
  db: D1Database,
  accountId: string,
  fromAccountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ from_account_id: string }>(
      db,
      hasNotificationAcceptanceSql(accountId, fromAccountId),
    );
    return rows.length > 0;
  });
