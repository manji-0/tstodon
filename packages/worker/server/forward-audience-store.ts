import type { StatusTarget } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { statusTargetColumns } from "./status-store";

/**
 * The local accounts whose remote followers a forward reaches, as Mastodon's
 * `ActivityPub::Forwarder#inboxes` reads them: those that boosted or quoted
 * `target`, whatever the quote's state, and `repliedToAccountId`, the local
 * author the status replies to.
 */
export type ForwardAudience = Readonly<{
  target: StatusTarget;
  repliedToAccountId: string | undefined;
}>;

/**
 * The statement that stores `audience` (`forward_audiences`) for the forward
 * `activityId`, when that row exists: run in the batch that inserts the
 * forward, it stores the audience only for the call that stored the
 * forward, and before the activity is applied (a `Delete` removes the boosts).
 */
export const insertForwardAudienceStatement = (
  db: D1Database,
  activityId: string,
  audience: ForwardAudience,
): D1PreparedStatement =>
  db
    .prepare(
      `INSERT OR IGNORE INTO forward_audiences (activity_id, account_id)
       SELECT ?1, account_id FROM (
         SELECT account_id FROM statuses
         WHERE kind = 'LocalReblog' AND (reblog_of_id = ?2 OR reblog_of_remote_id = ?3)
         UNION
         SELECT s.account_id FROM status_quotes q
         JOIN statuses s ON s.id = q.status_id
         WHERE q.quoted_status_id = ?2 OR q.quoted_remote_status_id = ?3
         UNION
         SELECT ?4 WHERE ?4 IS NOT NULL
       )
       WHERE EXISTS (SELECT 1 FROM outbound_activities WHERE id = ?1)`,
    )
    .bind(activityId, ...statusTargetColumns(audience.target), audience.repliedToAccountId ?? null);

const AccountIdRow = z.object({ account_id: z.string() });

/** The next `limit` accounts of the forward's audience, by id after `afterAccountId` (empty for the first page). */
export const listForwardAudiencePage = async (
  db: D1Database,
  activityId: string,
  afterAccountId: string,
  limit: number,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT account_id FROM forward_audiences
         WHERE activity_id = ? AND account_id > ?
         ORDER BY account_id LIMIT ?`,
      )
      .bind(activityId, afterAccountId, limit)
      .all();
    return parseRows(AccountIdRow, rows.results).map((row) => row.account_id);
  });

/** Forget the forward's audience once its last page is expanded. */
export const deleteForwardAudience = async (
  db: D1Database,
  activityId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db.prepare("DELETE FROM forward_audiences WHERE activity_id = ?").bind(activityId).run();
  });
