import { schemaResult } from "@tstodon/core";
import { type Hostname, NotificationPolicy, NotificationPolicyAction } from "@tstodon/domain";
import { nowIso } from "./clock";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, runD1, runD1Batch, type RepositoryError } from "./d1";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { newEntityId } from "./ids";
import {
  countNotificationRequests as countNotificationRequestsSql,
  deleteEmptyNotificationRequestGroupsJson as deleteEmptyNotificationRequestGroupsJsonSql,
  deleteNotificationRequestsJson as deleteNotificationRequestsJsonSql,
  dismissNotificationRequestsJson as dismissNotificationRequestsJsonSql,
  findNotificationPolicy as findNotificationPolicySql,
  hasNotificationAcceptance as hasNotificationAcceptanceSql,
  insertNotificationAcceptancesJson as insertNotificationAcceptancesJsonSql,
  insertNotificationRequest as insertNotificationRequestSql,
  listNotificationRequestSendersJson as listNotificationRequestSendersJsonSql,
  upsertNotificationPolicy as upsertNotificationPolicySql,
} from "./generated/prisma/sql";
import { RemoteAccountId } from "./remote-account-id";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";

const RequestsNotificationsRow = z.object({ requests: z.number(), notifications: z.number() });
const FromAccountIdRow = z.object({ from_account_id: z.string() });

const PolicyRowSchema = z.object({
  for_not_following: z.string(),
  for_not_followers: z.string(),
  for_new_accounts: z.string(),
  for_private_mentions: z.string(),
  for_limited_accounts: z.string(),
  for_bots: z.string(),
});

const action = (raw: string, fallback: NotificationPolicyAction): NotificationPolicyAction => {
  const parsed = NotificationPolicyAction.parse(raw);
  return parsed.isOk() ? parsed.value : fallback;
};

export const findNotificationPolicy = async (
  db: D1Database,
  accountId: string,
): Promise<Result<NotificationPolicy, RepositoryError>> =>
  runD1(async () => {
    const [row] = await queryTyped(db, findNotificationPolicySql(accountId), PolicyRowSchema);
    if (row === undefined) {
      return { ...NotificationPolicy.default };
    }
    return {
      forNotFollowing: action(row.for_not_following, NotificationPolicy.default.forNotFollowing),
      forNotFollowers: action(row.for_not_followers, NotificationPolicy.default.forNotFollowers),
      forNewAccounts: action(row.for_new_accounts, NotificationPolicy.default.forNewAccounts),
      forPrivateMentions: action(
        row.for_private_mentions,
        NotificationPolicy.default.forPrivateMentions,
      ),
      forLimitedAccounts: action(
        row.for_limited_accounts,
        NotificationPolicy.default.forLimitedAccounts,
      ),
      forBots: action(row.for_bots, NotificationPolicy.default.forBots),
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
        policy.forBots,
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
    const rows = await queryTyped(
      db,
      countNotificationRequestsSql(accountId),
      RequestsNotificationsRow,
    );
    return {
      requests: Number(rows[0]?.requests ?? 0),
      notifications: Number(rows[0]?.notifications ?? 0),
    };
  });

/**
 * Hold a notification as a request. A held mention also keeps its status out
 * of the account's conversations until the sender is accepted
 * (`withheld_conversation_statuses`).
 */
export const holdNotification = async (
  db: D1Database,
  notificationId: string,
  accountId: string,
  fromAccountId: string,
  statusId: string | undefined,
  mention: boolean,
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
    if (mention && statusId !== undefined) {
      await db
        .prepare(
          `INSERT INTO withheld_conversation_statuses (account_id, from_account_id, status_id)
           VALUES (?, ?, ?)
           ON CONFLICT(account_id, status_id) DO NOTHING`,
        )
        .bind(accountId, fromAccountId, statusId)
        .run();
    }
  });
  return written.map(() => undefined);
};

/**
 * The senders whose requests `ids` name, by request id or by sender id; ids
 * that name none of the account's requests are left out.
 */
export const findNotificationRequestSenders = async (
  db: D1Database,
  accountId: string,
  ids: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  ids.length === 0
    ? ok([])
    : runD1(async () =>
        (
          await queryTyped(
            db,
            listNotificationRequestSendersJsonSql(accountId, jsonStringArray([...ids])),
            FromAccountIdRow,
          )
        ).map((row) => row.from_account_id),
      );

/**
 * Run `around` and then delete the senders' requests and their emptied
 * groups, in one batch. Resolves to the batch's results.
 */
const closeNotificationRequests = async (
  db: D1Database,
  accountId: string,
  fromAccountIds: ReadonlyArray<string>,
  around: (sendersJson: string) => ReadonlyArray<D1PreparedStatement>,
): Promise<Result<D1Result[], RepositoryError>> => {
  if (fromAccountIds.length === 0) {
    return ok([]);
  }
  const senders = jsonStringArray([...fromAccountIds]);
  return runD1Batch(db, [
    ...around(senders),
    d1PrepareTyped(db, deleteNotificationRequestsJsonSql(accountId, senders)),
    d1PrepareTyped(db, deleteEmptyNotificationRequestGroupsJsonSql(accountId, senders)),
  ]);
};

const StatusIdRow = z.object({ status_id: z.string() });

/**
 * Accept senders: their held notifications merge back into the list, later
 * ones are not held, and the statuses their held mentions kept out of the
 * account's conversations join them, as Mastodon's
 * `UnfilterNotificationsWorker`. One batch however many senders. Resolves to
 * the ids of those statuses.
 */
export const acceptNotificationRequests = async (
  db: D1Database,
  accountId: string,
  fromAccountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  (
    await closeNotificationRequests(db, accountId, fromAccountIds, (senders) => [
      d1PrepareTyped(db, insertNotificationAcceptancesJsonSql(accountId, senders, nowIso())),
      db
        .prepare(
          `DELETE FROM withheld_conversation_statuses
           WHERE account_id = ? AND from_account_id IN (SELECT value FROM json_each(?))
             AND held = 1
           RETURNING status_id`,
        )
        .bind(accountId, senders),
    ])
  ).map((results) => parseRows(StatusIdRow, results[1]?.results).map((row) => row.status_id));

/**
 * Dismiss senders: their held notifications are discarded, and the statuses
 * those kept out of the account's conversations stay out once the senders
 * are accepted, as Mastodon's `FilteredNotificationCleanupWorker` deletes the
 * notifications `UnfilterNotificationsWorker` would read. One batch however
 * many senders and notifications.
 */
export const dismissNotificationRequests = async (
  db: D1Database,
  accountId: string,
  fromAccountIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> =>
  (
    await closeNotificationRequests(db, accountId, fromAccountIds, (senders) => [
      d1PrepareTyped(db, dismissNotificationRequestsJsonSql(accountId, senders, nowIso())),
      db
        .prepare(
          `UPDATE withheld_conversation_statuses SET held = 0
           WHERE account_id = ? AND from_account_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, senders),
    ])
  ).map(() => undefined);

export const isSenderAccepted = async (
  db: D1Database,
  accountId: string,
  fromAccountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      hasNotificationAcceptanceSql(accountId, fromAccountId),
      FromAccountIdRow,
    );
    return rows.length > 0;
  });

/**
 * Forget the senders on `domain` (every port of it, as their account domain
 * or their URI's host) whose requests the
 * account accepted, as Mastodon's `clear_notification_permissions!` does when
 * the account blocks the domain. An acceptance names its sender by `r_…` id,
 * so the account's remote ones are decoded to find the domain's actors.
 */
export const forgetDomainNotificationAcceptances = async (
  db: D1Database,
  accountId: string,
  domain: Hostname,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT from_account_id FROM notification_request_acceptances WHERE account_id = ?")
      .bind(accountId)
      .all();
    const senders = (results ?? []).flatMap((raw) => {
      const row = schemaResult(FromAccountIdRow)(raw);
      if (row.isErr()) {
        return [];
      }
      const actorUri = RemoteAccountId.decode(row.value.from_account_id);
      return actorUri.isOk() ? [[row.value.from_account_id, actorUri.value]] : [];
    });
    if (senders.length === 0) {
      return;
    }
    await db
      .prepare(
        `DELETE FROM notification_request_acceptances
         WHERE account_id = ? AND from_account_id IN (
           SELECT json_extract(s.value, '$[0]') FROM json_each(?) s
           JOIN remote_actors r ON r.actor_uri = json_extract(s.value, '$[1]')
           WHERE ? IN (r.host, r.uri_host)
         )`,
      )
      .bind(accountId, JSON.stringify(senders), domain)
      .run();
  });
