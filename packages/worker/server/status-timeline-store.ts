import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { containsFolded, parseRows, type RepositoryError, runD1 } from "./d1";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import {
  EXCLUSIVE_LIST_MEMBER_ACCOUNTS_SQL,
  FEED_LANGUAGES_SQL,
  FEED_SUSPENDED_AUTHORS_SQL,
  feedLocalMentionsSql,
  feedLocalReblogsSql,
  feedLocalRepliesSql,
  followedTagHorizonSql,
  followedTagNoteIdsSql,
  reblogOfShownAuthorSql,
} from "./followed-feed";
import { type IdCursor, idCursorBounds, idCursorFragment, newestFirst } from "./id-cursor";
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

/**
 * Mastodon's `Status.without_replies`: a status that is no reply, or a reply
 * that answers its own author (`in_reply_to_account_id = account_id`). A
 * reply keeps whom it answers after its parent is deleted, as Mastodon's
 * `reply` flag stays.
 */
const WITHOUT_REPLIES_SQL = `(in_reply_to_account_id = account_id OR (
  in_reply_to_id IS NULL AND in_reply_to_uri IS NULL
  AND in_reply_to_account_id IS NULL AND in_reply_to_actor_uri IS NULL))`;

/** Media-only timelines keep statuses with an attachment, as `only_media` asks. */
export const WITH_MEDIA_SQL = `AND id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL)`;

/**
 * Public local notes, without the authors `viewerId` must not see. Boosts and
 * replies to someone else stay off, as Mastodon's `PublicFeed` is
 * `without_reblogs` and `without_replies`.
 */
export const listPublicStatuses = async (
  db: D1Database,
  viewerId: string | undefined,
  limit: number,
  cursor: StatusCursor = {},
  onlyMedia = false,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const media = onlyMedia ? WITH_MEDIA_SQL : "";
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE kind = 'LocalNote' AND visibility = 'public'
         AND ${WITHOUT_REPLIES_SQL} ${MODERATED_ACCOUNTS_SQL}
         AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL} ${media} ${where} ${order} LIMIT ?`,
      )
      .bind(...suppressedBinds(viewerId), ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/** `SUPPRESSED_ACCOUNT_IDS_SQL`'s binds; an anonymous viewer suppresses nobody. */
export const suppressedBinds = (viewerId: string | undefined): string[] => {
  const viewer = viewerId ?? "";
  return [viewer, viewer, viewer, nowIso()];
};

/**
 * The page's horizon over the viewer's followed hashtags
 * ({@link followedTagHorizonSql}): `undefined` when the hashtags are read to
 * their end, and for a single entry (`onlyId`).
 */
export const findFollowedTagHorizon = async (
  db: D1Database,
  viewerId: string,
  cursor: StatusCursor,
  limit: number,
): Promise<Result<string | undefined, RepositoryError>> => {
  if ((cursor.onlyId ?? "").length > 0) {
    return ok(undefined);
  }
  return runD1(async () => {
    const { sql, binds } = followedTagHorizonSql(viewerId, cursor, limit);
    const row = await db
      .prepare(sql)
      .bind(...binds)
      .first();
    const [parsed] = parseRows(HorizonRow, row === null ? [] : [row]);
    return parsed?.horizon ?? undefined;
  });
};

const HorizonRow = z.object({ horizon: z.string().nullable() });

export const listHomeStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
  horizon: string | undefined = undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const suppressed = `AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
         ${FEED_SUSPENDED_AUTHORS_SQL}`;
    const { where, order, binds } = cursorFragment(cursor);
    const now = nowIso();
    const reblogs = feedLocalReblogsSql(accountId, now);
    const mentions = feedLocalMentionsSql(accountId, now);
    const tagged = followedTagNoteIdsSql("Local", accountId, now, cursor, horizon);
    const replies = feedLocalRepliesSql({ kind: "Home" }, accountId);
    // The viewer's own statuses always (`deliver_to_self!`). A followed
    // author's as `filter_from_home` keeps them: a direct or limited note only when it
    // mentions the viewer (`deliver_to_mentioned_followers!`), a reply only to
    // whom it keeps one, none from a member of an exclusive list, and the
    // follow's languages. A followed hashtag's public notes as
    // `filter_from_tags?`, which has none of those rules.
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE (account_id = ? OR (account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         ) AND (visibility NOT IN ('direct', 'limited') OR EXISTS (
           SELECT 1 FROM status_mentions m WHERE m.status_id = statuses.id AND m.account_id = ?
         )) ${replies.sql}
           AND account_id NOT IN ${EXCLUSIVE_LIST_MEMBER_ACCOUNTS_SQL}
           ${FEED_LANGUAGES_SQL}) OR id IN ${tagged.sql})
         ${suppressed}
         ${reblogs.sql}
         ${mentions.sql}
         ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        accountId,
        accountId,
        accountId,
        ...replies.binds,
        // Exclusive lists: the viewer.
        accountId,
        // `FEED_LANGUAGES_SQL`: the viewer.
        accountId,
        ...tagged.binds,
        // `SUPPRESSED_ACCOUNT_IDS_SQL` takes the viewer twice and its clock.
        accountId,
        accountId,
        accountId,
        now,
        ...reblogs.binds,
        ...mentions.binds,
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
  excludeDirect: boolean;
  onlyMedia: boolean;
  tagged?: string | undefined;
  /** Only the account's pins, newest pin first (`pinned_scope`). */
  pinned?: boolean | undefined;
}>;

/**
 * An account's statuses as `viewerId` may see them, kept in SQL (Mastodon's
 * `AccountStatusesFilter`) so a page holds `limit` visible statuses: the
 * author sees all; an account the author blocks sees none; anyone else sees
 * public and unlisted ones, followers-only ones when following, and, unless
 * `excludeDirect`, the ones that mention them; and only the boosts of authors
 * they see (`filtered_reblogs_scope`). `excludeReplies` keeps the replies
 * that answer the author (`no_replies_scope`).
 */
export const listAccountStatusesFiltered = async (
  db: D1Database,
  accountId: string,
  viewerId: string | undefined,
  filters: AccountStatusFilters,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const tagged = filters.tagged?.replace(/^#/, "") ?? "";
    const viewer = viewerId ?? "";
    const { where, order, binds } = cursorFragment(filters.cursor);
    // Pins drive the read from their own index, so a page does not walk every
    // status of the account. Mastodon's `pinned_statuses` orders by pin time,
    // and `to_a_paginated_by_id` by id within it, or by id alone for a
    // `min_id` page.
    const source =
      filters.pinned === true
        ? {
            sql: `(SELECT s.*, p.created_at AS pinned_at FROM status_pins p
              CROSS JOIN statuses s ON s.id = p.status_id
              WHERE p.account_id = ?) AS statuses`,
            binds: [accountId],
            order: idCursorBounds(filters.cursor).ascending
              ? order
              : "ORDER BY pinned_at DESC, id DESC",
          }
        : { sql: "statuses", binds: [], order };
    const reblogs = reblogOfShownAuthorSql(viewer, nowIso());
    const sql = `SELECT ${statusSelect} FROM ${source.sql}
         WHERE account_id = ?
           AND (account_id = ? OR (
             NOT EXISTS (
               SELECT 1 FROM blocks WHERE blocker_account_id = ? AND target_account_id = ?
             )
             AND (
               visibility IN ('public', 'unlisted')
               OR (visibility = 'private' AND EXISTS (
                 SELECT 1 FROM follows
                 WHERE follower_account_id = ? AND target_account_id = ? AND kind = 'Accepted'
               ))
               OR (? = 0 AND id IN (SELECT status_id FROM status_mentions WHERE account_id = ?))
             )
           ))
           AND (kind <> 'LocalReblog' OR ? = '' OR account_id = ? OR (${reblogs.sql}))
           AND (? = 0 OR ${WITHOUT_REPLIES_SQL})
           AND (? = 0 OR kind <> 'LocalReblog')
           AND (? = 0 OR visibility NOT IN ('direct', 'limited'))
           AND (? = 0 OR id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL))
           AND (? = '' OR id IN (SELECT status_id FROM local_status_tags WHERE tag = ?))
           ${where} ${source.order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        ...source.binds,
        accountId,
        viewer,
        // Bound rather than read off each row, so SQLite checks the block and follow once.
        accountId,
        viewer,
        viewer,
        accountId,
        filters.excludeDirect ? 1 : 0,
        viewer,
        viewer,
        viewer,
        ...reblogs.binds,
        filters.excludeReplies ? 1 : 0,
        filters.excludeReblogs ? 1 : 0,
        filters.excludeDirect ? 1 : 0,
        filters.onlyMedia ? 1 : 0,
        tagged,
        tagged,
        ...binds,
        filters.limit,
      )
      .all();
    return newestFirst(filters.cursor ?? {}, await hydrateStatusRows(db, results ?? []));
  });

/**
 * Mastodon's `StatusFilter` on a local author, for a statement over
 * `statuses`: a suspended author's status is left out, and a silenced
 * author's unless the viewer is that author or follows it (accepted). Each
 * row seeks its author's moderation, and a silenced one the follow, by key.
 * Bind order: (viewerId, viewerId), `''` when anonymous.
 */
const SILENCED_UNFOLLOWED_OR_SUSPENDED_SQL = `AND NOT EXISTS (
  SELECT 1 FROM account_moderation AS m
  WHERE m.account_id = statuses.account_id
    AND (
      m.moderation = 'Suspended'
      OR (
        m.account_id <> ?
        AND NOT EXISTS (
          SELECT 1 FROM follows AS f
          WHERE f.follower_account_id = ? AND f.target_account_id = m.account_id
            AND f.kind = 'Accepted'
        )
      )
    )
)`;

/**
 * Local notes whose text contains `query`, newest first, kept in SQL to the
 * ones `viewerId` may see (as `canViewStatus`, without its direct reply
 * chains) and that Mastodon's `StatusFilter` keeps (blocks, mutes, and
 * moderated authors), so that `offset` skips only visible results.
 */
export const searchStatuses = async (
  db: D1Database,
  viewerId: string | undefined,
  query: string,
  limit: number,
  offset: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const viewer = viewerId ?? "";
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' ${SILENCED_UNFOLLOWED_OR_SUSPENDED_SQL}
           AND ${containsFolded("content_text")}
           AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
           AND (
             visibility IN ('public', 'unlisted')
             OR account_id = ?
             OR (visibility = 'private' AND account_id IN (
               SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
             ))
             OR (visibility IN ('direct', 'limited') AND id IN (
               SELECT status_id FROM status_mentions WHERE account_id = ?
             ))
           )
         ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .bind(
        viewer,
        viewer,
        query,
        ...suppressedBinds(viewerId),
        viewer,
        viewer,
        viewer,
        limit,
        offset,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });
