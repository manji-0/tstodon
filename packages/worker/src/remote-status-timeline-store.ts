import { type RemoteStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { listPublicRemoteStatuses as listPublicRemoteStatusesSql } from "./generated/prisma/sql";
import type { AccountStatusFilters, StatusCursor } from "./status-timeline-store";
import type { TagStatusFilters } from "./status-discovery-store";
import { queryTyped } from "./typed-sql";
import { idCursorFragment } from "./id-cursor";
import { feedFollowSql, feedRepliesSql, type FollowedFeed } from "./followed-feed";
import { parseRemoteStatusRow, remoteStatusFromRow } from "./remote-status-store";

/**
 * Remote direct notes that address the account, newest first, leaving out
 * actors the account blocks or mutes and domains it blocks or the instance
 * limits or suspends — the same ones remote timelines drop.
 */
export const listRemoteDirectStatusesForAccount = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const binds: (string | number)[] = [accountId, accountId, accountId, nowIso(), accountId];
    const before = maxId ? "AND s.id < ?" : "";
    if (maxId) {
      binds.push(maxId);
    }
    binds.push(limit);
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM remote_statuses s
         WHERE s.visibility = 'direct'
           AND s.id IN (SELECT status_id FROM remote_status_mentions WHERE account_id = ?)
           AND s.actor_uri NOT IN (SELECT target_actor_uri FROM blocks WHERE blocker_account_id = ?)
           AND s.actor_uri NOT IN (
             SELECT target_actor_uri FROM mutes
             WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
           )
           AND s.actor_uri NOT IN (
             SELECT actor_uri FROM remote_actors
             WHERE lower(domain) IN (
               SELECT lower(domain) FROM account_domain_blocks WHERE account_id = ?
               UNION
               SELECT lower(domain) FROM domain_blocks WHERE severity IN ('silence', 'suspend')
             )
           )
           ${before}
         ORDER BY s.id DESC LIMIT ?`,
      )
      .bind(...binds)
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

/**
 * Remote statuses on one of the account's followed feeds (home or a list): the
 * public, unlisted, and followers-only notes of actors it follows (accepted)
 * on that feed, newest first. A follow with `languages[]` keeps statuses in
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
    const { results } = await db
      .prepare(
        `SELECT ${REMOTE_STATUS_SELECT} FROM (
           SELECT s.* FROM remote_statuses s
           JOIN outbound_follows f
             ON f.actor_uri = s.actor_uri AND f.account_id = ? AND f.state = 'Accepted'
                ${follows.sql}
           WHERE s.visibility <> 'direct'
             ${replies.sql}
             AND NOT (
               f.languages_json <> '[]'
               AND COALESCE(s.language, '') <> ''
               AND s.language NOT IN (SELECT value FROM json_each(f.languages_json))
             )
             AND s.actor_uri NOT IN (SELECT target_actor_uri FROM blocks WHERE blocker_account_id = ?)
             AND s.actor_uri NOT IN (
               SELECT target_actor_uri FROM mutes
               WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?)
             )
             AND s.actor_uri NOT IN (
               SELECT actor_uri FROM remote_actors
               WHERE lower(domain) IN (
                 SELECT lower(domain) FROM account_domain_blocks WHERE account_id = ?
                 UNION
                 SELECT lower(domain) FROM domain_blocks WHERE severity = 'suspend'
               )
             )
         ) s WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        accountId,
        ...follows.binds,
        ...replies.binds,
        accountId,
        accountId,
        nowIso(),
        accountId,
        ...binds,
        limit,
      )
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

/**
 * A remote actor's cached notes on its profile, newest first, as the viewer
 * may see them: public and unlisted ones for everyone, followers-only ones
 * for its accepted followers, and any note that mentions the viewer.
 * `exclude_replies`, `only_media`, and `tagged` narrow them as for a local
 * account.
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
               OR s.id IN (SELECT status_id FROM remote_status_mentions WHERE account_id = ?)
             )
             AND (? = 0 OR s.in_reply_to_uri IS NULL)
             AND (? = 0 OR s.media_json NOT IN ('[]', ''))
             AND (? = '' OR EXISTS (
               SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?
             ))
         ) s WHERE 1 = 1 ${where} ${order} LIMIT ?`,
      )
      .bind(
        actorUri,
        viewer,
        viewer,
        filters.excludeReplies ? 1 : 0,
        filters.onlyMedia ? 1 : 0,
        tagged,
        tagged,
        ...binds,
        filters.limit,
      )
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

export const listPublicRemoteStatuses = async (
  db: D1Database,
  limit: number,
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPublicRemoteStatusesSql(limit));
    const statuses: RemoteStatus[] = [];
    for (const raw of results) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

/**
 * Remote statuses on a tag timeline. Tags are read from the stored HTML (the
 * same `#tag` extraction the local notes use), over a bounded window of recent
 * public statuses, because the remote rows carry no tag index.
 */
export const REMOTE_STATUS_SELECT = `s.id, s.actor_uri, s.object_uri, s.url, s.content_html, s.spoiler_text,
       s.visibility, s.sensitive, s.language, s.published_at, s.edited_at, s.media_json, s.card_json, s.poll_json`;

export const listTagRemoteStatuses = async (
  db: D1Database,
  tag: string,
  limit: number,
  cursor: StatusCursor = {},
  filters: TagStatusFilters = { any: [], all: [], none: [], onlyMedia: false },
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
    const conditions = [
      "s.visibility = 'public'",
      "EXISTS (SELECT 1 FROM remote_status_tags t WHERE t.status_id = s.id AND t.tag = ?)",
    ];
    const binds: string[] = [tag.replace(/^#/, "").toLowerCase()];
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
    // Mastodon's id cursors, newest first unless `min_id` pages upward.
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
         WHERE ${conditions.join(" AND ")} ${cursorWhere} ${order} LIMIT ?`,
      )
      .bind(...binds, ...(cursorId.length > 0 ? [cursorId] : []), limit)
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

/** Public remote statuses whose preview card was unfurled from `url` (the link timeline). */
export const listLinkRemoteStatuses = async (
  db: D1Database,
  url: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<RemoteStatus[], RepositoryError>> =>
  runD1(async () => {
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
         WHERE s.card_url = ? AND s.visibility = 'public' ${cursorWhere} ${order} LIMIT ?`,
      )
      .bind(url, ...(cursorId.length > 0 ? [cursorId] : []), limit)
      .all();
    const statuses: RemoteStatus[] = [];
    for (const raw of results ?? []) {
      const row = parseRemoteStatusRow(raw);
      if (row.isErr()) {
        continue;
      }
      const parsed = remoteStatusFromRow(row.value);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });
