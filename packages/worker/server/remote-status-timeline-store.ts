import { type RemoteStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { SUPPRESSED_ACTOR_URIS_SQL } from "./block-mute-store";
import { nowIso } from "./clock";
import { okValues, type RepositoryError, runD1 } from "./d1";
import type { AccountStatusFilters, StatusCursor } from "./status-timeline-store";
import type { TagStatusFilters } from "./status-discovery-store";
import { idCursorFragment, type IdCursor } from "./id-cursor";
import { DOMAIN_RESTRICTED_ACTORS_SQL, DOMAIN_SUSPENDED_ACTORS_SQL } from "./domain-hidden-actors";
import {
  feedFollowSql,
  feedRepliesSql,
  type FollowedFeed,
  followedTagNoteIdsSql,
  mentionsBlockedOrMutedSql,
} from "./followed-feed";
import { parseRemoteStatusRow, remoteStatusFromRow } from "./remote-status-store";

/**
 * Remote direct notes that address the account, newest first, leaving out
 * actors the account blocks or mutes or that block it, and domains it blocks
 * or the instance limits or suspends — the same ones remote timelines drop —
 * and notes whose mention a notification request holds.
 */
export const listRemoteDirectStatusesForAccount = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const binds: (string | number)[] = [
      accountId,
      accountId,
      accountId,
      accountId,
      nowIso(),
      accountId,
    ];
    const before = maxId ? "AND m.status_id < ?" : "";
    if (maxId) {
      binds.push(maxId);
    }
    binds.push(limit);
    // Driven from the account's mentions in status id order, so a page reads
    // the notes that address it, not every one of theirs or every direct note.
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_status_mentions m
         CROSS JOIN remote_statuses s ON s.id = m.status_id
         WHERE m.account_id = ?
           AND s.visibility = 'direct'
           AND s.actor_uri NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
           AND s.actor_uri NOT IN ${DOMAIN_RESTRICTED_ACTORS_SQL}
           AND NOT EXISTS (
             SELECT 1 FROM withheld_conversation_statuses w
             WHERE w.account_id = m.account_id AND w.status_id = m.status_id
           )
           ${before}
         ORDER BY m.status_id DESC LIMIT ?`,
      )
      .bind(...binds)
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });

/**
 * Remote statuses on one of the account's followed feeds (home or a list): the
 * public, unlisted, and followers-only notes of actors it follows (accepted)
 * on that feed, newest first. Home also has their limited and direct notes
 * that address the account, as Mastodon's
 * `FanOutOnWriteService#deliver_to_mentioned_followers!` (a list has none),
 * whether or not a notification request holds the mention. A follow with `languages[]` keeps statuses in
 * those languages only (and ones without a language). Actors the account
 * blocks or mutes, domains it blocks, and suspended domains stay out; silenced
 * ones are still shown to followers, as in Mastodon.
 */
export const listFollowedRemoteStatuses = async (
  db: D1Database,
  accountId: string,
  feed: FollowedFeed,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const follows = feedFollowSql(feed);
    const replies = feedRepliesSql(feed, accountId);
    const now = nowIso();
    const mentions = mentionsBlockedOrMutedSql(accountId, now, { remote: "s.id" });
    const addressed =
      feed.kind === "Home"
        ? `OR (s.visibility IN ('limited', 'direct') AND EXISTS (
             SELECT 1 FROM remote_status_mentions m
             WHERE m.status_id = s.id AND m.account_id = f.account_id
           ))`
        : "";
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM (
           SELECT s.* FROM remote_statuses s
           JOIN outbound_follows f
             ON f.actor_uri = s.actor_uri AND f.account_id = ? AND f.state = 'Accepted'
                ${follows.sql}
           WHERE (s.visibility IN ('public', 'unlisted', 'private') ${addressed})
             ${replies.sql}
             AND NOT (
               f.languages_json <> '[]'
               AND COALESCE(s.language, '') <> ''
               AND s.language NOT IN (SELECT value FROM json_each(f.languages_json))
             )
             AND s.actor_uri NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
             AND s.actor_uri NOT IN ${DOMAIN_SUSPENDED_ACTORS_SQL}
             AND NOT ${mentions.sql}
         ) s WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        accountId,
        ...follows.binds,
        ...replies.binds,
        accountId,
        accountId,
        accountId,
        now,
        accountId,
        ...mentions.binds,
        ...binds,
        limit,
      )
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });

/**
 * The remote notes a followed hashtag brings to the account's home
 * ({@link followedTagNoteIdsSql}), newest first, as Mastodon's
 * `FeedManager#filter_from_tags?` keeps them: not from an actor it blocks or
 * mutes or that blocks it, nor from a domain it blocks or the instance limits
 * or suspends. An actor it follows is left out, as
 * {@link listFollowedRemoteStatuses} lists its notes already.
 */
export const listFollowedTagRemoteStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  cursor: StatusCursor = {},
  horizon: string | undefined = undefined,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const now = nowIso();
    const tagged = followedTagNoteIdsSql("Remote", accountId, now, cursor, horizon);
    const mentions = mentionsBlockedOrMutedSql(accountId, now, { remote: "s.id" });
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM (
           SELECT s.* FROM remote_statuses s
           WHERE s.id IN ${tagged.sql}
             AND s.actor_uri NOT IN (
               SELECT actor_uri FROM outbound_follows WHERE account_id = ? AND state = 'Accepted'
             )
             AND s.actor_uri NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
             AND s.actor_uri NOT IN ${DOMAIN_RESTRICTED_ACTORS_SQL}
             AND NOT ${mentions.sql}
         ) s WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        ...tagged.binds,
        accountId,
        accountId,
        accountId,
        accountId,
        now,
        accountId,
        ...mentions.binds,
        ...binds,
        limit,
      )
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });

/**
 * A remote actor's cached notes on its profile, newest first, as the viewer
 * may see them: public and unlisted ones for everyone, followers-only ones
 * for its accepted followers, and, unless `exclude_direct`, any note that
 * mentions the viewer. `exclude_replies`, `only_media`, and `tagged` narrow
 * them as for a local account.
 */
export const listActorRemoteStatuses = async (
  db: D1Database,
  actorUri: string,
  viewerId: string | undefined,
  filters: AccountStatusFilters,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const viewer = viewerId ?? "";
    const tagged = filters.tagged?.replace(/^#/, "").toLowerCase() ?? "";
    const { where, order, binds } = idCursorFragment(filters.cursor);
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM (
           SELECT s.* FROM remote_statuses s
           WHERE s.actor_uri = ?
             AND (
               s.visibility IN ('public', 'unlisted')
               OR (s.visibility = 'private' AND EXISTS (
                 SELECT 1 FROM outbound_follows f
                 WHERE f.account_id = ? AND f.actor_uri = s.actor_uri AND f.state = 'Accepted'
               ))
               OR (? = 0 AND s.id IN (SELECT status_id FROM remote_status_mentions WHERE account_id = ?))
             )
             AND (? = 0 OR s.in_reply_to_uri IS NULL)
             AND (? = 0 OR s.media_json NOT IN ('[]', ''))
             AND (? = '' OR EXISTS (
               SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?
             ))
             AND s.actor_uri NOT IN ${DOMAIN_SUSPENDED_ACTORS_SQL}
         ) s WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        actorUri,
        viewer,
        filters.excludeDirect ? 1 : 0,
        viewer,
        filters.excludeReplies ? 1 : 0,
        filters.onlyMedia ? 1 : 0,
        tagged,
        tagged,
        viewer,
        ...binds,
        filters.limit,
      )
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });

/**
 * Public remote statuses, newest id first, paged by the id cursor; `onlyId`
 * asks for one entry and `onlyMedia` keeps the ones with attachments. Actors
 * the viewer blocks or mutes or that block the viewer, domains it blocks or the instance limits or
 * suspends (matched against both the account domain and the actor URI's
 * host), and actors an admin moderated stay out before the limit.
 */
export const listPublicRemoteStatuses = async (
  db: D1Database,
  viewerId: string | undefined,
  limit: number,
  cursor: IdCursor,
  onlyMedia: boolean,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const viewer = viewerId ?? "";
    // One statement per cursor shape, so `onlyId` is a primary key lookup and
    // a page walks the `(visibility, id)` index without sorting every match.
    const { where, order, binds } = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_statuses s
         WHERE visibility = 'public'
           AND (? = 0 OR media_json NOT IN ('[]', ''))
           AND actor_uri NOT IN (
             SELECT target_actor_uri FROM blocks WHERE blocker_account_id = ?
             UNION
             SELECT actor_uri FROM remote_blocks WHERE account_id = ?
             UNION
             SELECT target_actor_uri FROM mutes
               WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
           )
           AND actor_uri NOT IN (
             SELECT actor_uri FROM remote_actors
             WHERE host IN (SELECT lower(domain) FROM account_domain_blocks WHERE account_id = ?)
               OR uri_host IN (SELECT lower(domain) FROM account_domain_blocks WHERE account_id = ?)
               OR host IN (SELECT lower(domain) FROM domain_blocks WHERE severity IN ('silence', 'suspend'))
               OR uri_host IN (SELECT lower(domain) FROM domain_blocks WHERE severity IN ('silence', 'suspend'))
           )
           AND actor_uri NOT IN (
             SELECT actor_uri FROM remote_actor_moderation WHERE moderation IS NOT NULL
           )
           ${where} ${order} LIMIT ?`,
      )
      .bind(onlyMedia ? 1 : 0, viewer, viewer, viewer, nowIso(), viewer, viewer, ...binds, limit)
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });

export const REMOTE_STATUS_SELECT = `s.id, s.actor_uri, s.object_uri, s.url, s.content_html, s.spoiler_text,
       s.visibility, s.sensitive, s.language, s.published_at, s.edited_at, s.media_json, s.card_json, s.poll_json, s.emojis_json, s.quote_policy_json`;

/**
 * Public remote statuses on a tag timeline, by their indexed tags
 * (`remote_status_tags`), with the `any`/`all`/`none` constraints.
 */
export const listTagRemoteStatuses = async (
  db: D1Database,
  viewerId: string | undefined,
  tag: string,
  limit: number,
  cursor: StatusCursor = {},
  filters: TagStatusFilters = { any: [], all: [], none: [], onlyMedia: false },
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const conditions = [
      "t0.tag = ?",
      "s.visibility = 'public'",
      `s.actor_uri NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}`,
      `s.actor_uri NOT IN ${DOMAIN_RESTRICTED_ACTORS_SQL}`,
    ];
    const viewer = viewerId ?? "";
    const binds: string[] = [
      tag.replace(/^#/, "").toLowerCase(),
      viewer,
      viewer,
      viewer,
      nowIso(),
      viewer,
    ];
    if (filters.any.length > 0) {
      conditions.push(
        `EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag IN (${filters.any.map(() => "?").join(", ")}))`,
      );
      binds.push(...filters.any.map((value) => value.toLowerCase()));
    }
    for (const required of filters.all) {
      conditions.push(
        "EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?)",
      );
      binds.push(required.toLowerCase());
    }
    for (const denied of filters.none) {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?)",
      );
      binds.push(denied.toLowerCase());
    }
    if (filters.onlyMedia) {
      conditions.push("s.media_json NOT IN ('[]', '')");
    }
    // Driven from the tag's index rows in status id order (CROSS JOIN fixes the
    // join order), so a page reads the tagged statuses, not every public one.
    const { where, order, binds: cursorBinds } = idCursorFragment(cursor, "t0.status_id");
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_status_tags t0
         CROSS JOIN remote_statuses s ON s.id = t0.status_id
         WHERE ${conditions.join(" AND ")} ${where} ${order} LIMIT ?`,
      )
      .bind(...binds, ...cursorBinds, limit)
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });

/**
 * Public remote statuses whose preview card was unfurled from `url` (the link
 * timeline), without the actors the viewer blocks or mutes and the domains it
 * blocks or the instance limits or suspends, all before the limit.
 */
export const listLinkRemoteStatuses = async (
  db: D1Database,
  viewerId: string | undefined,
  url: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const viewer = viewerId ?? "";
    const minId = cursor.minId ?? "";
    const sinceId = cursor.sinceId ?? "";
    const maxId = cursor.maxId ?? "";
    const cursorId = minId || sinceId || maxId;
    const cursorWhere =
      cursorId.length > 0 ? (maxId && !minId && !sinceId ? "AND s.id < ?" : "AND s.id > ?") : "";
    const order = minId.length > 0 ? "ORDER BY s.id ASC" : "ORDER BY s.id DESC";
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_statuses s
         WHERE s.card_url = ? AND s.visibility = 'public'
           AND s.actor_uri NOT IN ${SUPPRESSED_ACTOR_URIS_SQL}
           AND s.actor_uri NOT IN ${DOMAIN_RESTRICTED_ACTORS_SQL}
           ${cursorWhere} ${order} LIMIT ?`,
      )
      .bind(
        url,
        viewer,
        viewer,
        viewer,
        nowIso(),
        viewer,
        ...(cursorId.length > 0 ? [cursorId] : []),
        limit,
      )
      .all();
    return okValues(
      (results ?? []).map((raw) =>
        parseRemoteStatusRow(raw).andThen((row) => remoteStatusFromRow(row)),
      ),
    );
  });
