import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { hydrateStatusRows, statusSelect } from "./status-store";

/** Authors silenced or suspended by an admin are hidden from public surfaces. */
export const MODERATED_ACCOUNTS_SQL = `AND account_id NOT IN (SELECT account_id FROM account_moderation)`;

/**
 * Mastodon's `Account.searchable` also drops unapproved local accounts, so
 * trends (unlike the public timeline) skip pending ones. The directory and
 * account search carry the same rule in their own SQL.
 */
export const SEARCHABLE_ACCOUNTS_SQL = `AND account_id NOT IN (SELECT account_id FROM account_flags WHERE pending <> 0)`;

export type StatusCursor = IdCursor;

export const cursorFragment = idCursorFragment;

export const listPublicStatuses = async (
  db: D1Database,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE visibility = 'public' ${MODERATED_ACCOUNTS_SQL} ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listHomeStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const suppressed = `AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}`;
    const { where, order, binds } = cursorFragment(cursor);
    // Followers who turned reblogs off keep their own boosts out of the feed,
    // and a follow with `languages[]` only keeps statuses in those languages
    // (statuses without a language still pass, as in Mastodon).
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE visibility != 'direct' AND (account_id = ? OR account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         ))
         ${suppressed}
         AND (
           account_id = ? OR kind <> 'LocalReblog'
           OR account_id NOT IN (
             SELECT target_account_id FROM follows
             WHERE follower_account_id = ? AND kind = 'Accepted' AND reblogs = 0
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM follows f
           WHERE f.follower_account_id = ? AND f.kind = 'Accepted'
             AND f.target_account_id = statuses.account_id
             AND f.languages_json <> '[]'
             AND COALESCE(statuses.language, '') <> ''
             AND statuses.language NOT IN (SELECT value FROM json_each(f.languages_json))
         )
         ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        accountId,
        accountId,
        // `SUPPRESSED_ACCOUNT_IDS_SQL` takes the viewer twice and its clock.
        accountId,
        accountId,
        accountId,
        nowIso(),
        // Reblogs off: the viewer, then the follows being checked.
        accountId,
        accountId,
        // Languages: the follow whose list is checked.
        accountId,
        ...binds,
        limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export type AccountStatusFilters = Readonly<{
  limit: number;
  cursor?: StatusCursor;
  excludeReplies: boolean;
  excludeReblogs: boolean;
  onlyMedia: boolean;
  tagged?: string | undefined;
}>;

export const listAccountStatusesFiltered = async (
  db: D1Database,
  accountId: string,
  filters: AccountStatusFilters,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const tagged = filters.tagged?.replace(/^#/, "") ?? "";
    const { where, order, binds } = cursorFragment(filters.cursor);
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE account_id = ?
           AND (? = 0 OR in_reply_to_id IS NULL)
           AND (? = 0 OR kind <> 'LocalReblog')
           AND (? = 0 OR id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL))
           AND (? = '' OR content_text LIKE ?)
           ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        accountId,
        filters.excludeReplies ? 1 : 0,
        filters.excludeReblogs ? 1 : 0,
        filters.onlyMedia ? 1 : 0,
        tagged.length > 0 ? `%#${tagged}%` : "",
        tagged.length > 0 ? `%#${tagged}%` : "",
        ...binds,
        filters.limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const searchStatuses = async (
  db: D1Database,
  query: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE kind = 'LocalNote' ${MODERATED_ACCOUNTS_SQL} AND content_text LIKE ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(`%${query}%`, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listFavouritedStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE id IN (SELECT status_id FROM favourites WHERE account_id = ?)
         ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listBookmarkedStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE id IN (SELECT status_id FROM bookmarks WHERE account_id = ?)
         ${where} ${order} LIMIT ?`,
      )
      .bind(accountId, ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });
