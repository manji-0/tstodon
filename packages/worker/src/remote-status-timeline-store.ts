import { type RemoteStatus } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { listPublicRemoteStatuses as listPublicRemoteStatusesSql } from "./generated/prisma/sql";
import type { StatusCursor } from "./status-timeline-store";
import type { TagStatusFilters } from "./status-discovery-store";
import { queryTyped } from "./typed-sql";
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
       s.visibility, s.sensitive, s.language, s.published_at, s.media_json, s.card_json`;

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
