import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { hydrateStatusRows, statusSelect } from "./status-store";
import {
  cursorFragment,
  MODERATED_ACCOUNTS_SQL,
  SEARCHABLE_ACCOUNTS_SQL,
  type StatusCursor,
} from "./status-timeline-store";

/** Additional tag constraints on a tag timeline (`any[]`/`all[]`/`none[]`). */
export type TagStatusFilters = Readonly<{
  any: ReadonlyArray<string>;
  all: ReadonlyArray<string>;
  none: ReadonlyArray<string>;
  onlyMedia: boolean;
}>;

/**
 * Does `text` carry the primary tag and the `any`/`all`/`none` constraints?
 * Used for remote statuses, whose tags are matched from their stored HTML.
 */
export const matchesTagFilters = (
  present: ReadonlySet<string>,
  tag: string,
  filters: TagStatusFilters,
): boolean => {
  const primary = tag.replace(/^#/, "").toLowerCase();
  if (!present.has(primary)) {
    return false;
  }
  const has = (value: string): boolean => present.has(value.toLowerCase());
  if (filters.any.length > 0 && !filters.any.some(has)) {
    return false;
  }
  if (!filters.all.every(has)) {
    return false;
  }
  return !filters.none.some(has);
};

export const listTagStatuses = async (
  db: D1Database,
  tag: string,
  limit: number,
  cursor: StatusCursor = {},
  filters: TagStatusFilters = { any: [], all: [], none: [], onlyMedia: false },
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    // Hashtags are matched case-insensitively, like the primary one.
    const patterns = (tags: ReadonlyArray<string>): string[] =>
      tags.flatMap((value) => [`%#${value}%`, `%#${value.toLowerCase()}%`]);
    const contains = (tags: ReadonlyArray<string>): string =>
      tags.length === 0
        ? ""
        : ` AND (${patterns(tags)
            .map(() => "content_text LIKE ?")
            .join(" OR ")})`;
    const containsAll = (tags: ReadonlyArray<string>): string =>
      tags.length === 0
        ? ""
        : ` AND (${tags.map(() => "content_text LIKE ? AND content_text LIKE ?").join(" AND ")})`;
    const excludes = (tags: ReadonlyArray<string>): string =>
      tags.length === 0
        ? ""
        : ` AND ${patterns(tags)
            .map(() => "content_text NOT LIKE ?")
            .join(" AND ")}`;
    const onlyMedia = filters.onlyMedia
      ? " AND id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL)"
      : "";
    const sql = `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL}
           AND (content_text LIKE ? OR content_text LIKE ?)
           ${contains(filters.any)}${containsAll(filters.all)}${excludes(filters.none)}${onlyMedia}
         ${where} ${order} LIMIT ?`;
    const { results } = await db
      .prepare(sql)
      .bind(
        `%#${tag}%`,
        `%#${tag.toLowerCase()}%`,
        ...patterns(filters.any),
        ...patterns(filters.all),
        ...patterns(filters.none),
        ...binds,
        limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/** Public local notes whose preview card was unfurled from `url` (the link timeline). */
export const listLinkStatuses = async (
  db: D1Database,
  url: string,
  limit: number,
  cursor: StatusCursor = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = cursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE card_url = ? AND kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL}
         ${where} ${order} LIMIT ?`,
      )
      .bind(url, ...binds, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const extractHashtags = (text: string): string[] => {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([A-Za-z0-9_]+)/g)) {
    const tag = match[1];
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return [...tags];
};

export const listTrendingTags = async (
  db: D1Database,
  limit: number,
  options: Readonly<{ excluded?: ReadonlySet<string>; offset?: number }> = {},
): Promise<Result<ReadonlyArray<{ name: string; uses: number }>, RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT content_text FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL} ${SEARCHABLE_ACCOUNTS_SQL} AND created_at >= ?
         ORDER BY id DESC LIMIT 500`,
      )
      .bind(since)
      .all<{ content_text: string }>();
    const counts = new Map<string, number>();
    for (const row of results ?? []) {
      for (const tag of extractHashtags(row.content_text)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const offset = options.offset ?? 0;
    return [...counts.entries()]
      .filter(([name]) => !options.excluded?.has(name))
      .map(([name, uses]) => ({ name, uses }))
      .toSorted((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
      .slice(offset, offset + limit);
  });

export const listTrendingStatuses = async (
  db: D1Database,
  limit: number,
  options: Readonly<{ includeRejected?: boolean; offset?: number }> = {},
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect},
            (SELECT COUNT(*) FROM favourites f WHERE f.status_id = statuses.id) AS favourite_count,
            (SELECT COUNT(*) FROM statuses r WHERE r.reblog_of_id = statuses.id) AS reblog_count
         FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' ${MODERATED_ACCOUNTS_SQL} ${SEARCHABLE_ACCOUNTS_SQL} AND created_at >= ?
           ${options.includeRejected ? "" : "AND statuses.id NOT IN (SELECT target FROM trend_reviews WHERE kind = 'Status' AND state = 'Rejected')"}
         ORDER BY (favourite_count + reblog_count) DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(since, limit, options.offset ?? 0)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/** Weekly status and registration counts; `week` is the Monday 00:00 UTC as UNIX seconds. */
export const listWeeklyStatusActivity = async (
  db: D1Database,
  weeks: number,
): Promise<
  Result<ReadonlyArray<{ week: string; statuses: number; registrations: number }>, RepositoryError>
> =>
  runD1(async () => {
    const { results: statusRows } = await db
      .prepare(
        `SELECT strftime('%s', date(created_at, '-6 days', 'weekday 1')) AS week, COUNT(*) AS statuses
         FROM statuses
         WHERE created_at >= datetime('now', ?)
         GROUP BY week
         ORDER BY week DESC
         LIMIT ?`,
      )
      .bind(`-${weeks * 7} days`, weeks)
      .all<{ week: string; statuses: number }>();
    const { results: registrationRows } = await db
      .prepare(
        `SELECT strftime('%s', date(created_at, '-6 days', 'weekday 1')) AS week, COUNT(*) AS registrations
         FROM accounts
         WHERE created_at >= datetime('now', ?)
         GROUP BY week`,
      )
      .bind(`-${weeks * 7} days`)
      .all<{ week: string; registrations: number }>();
    const registrations = new Map(
      (registrationRows ?? []).map((row) => [row.week, Number(row.registrations)]),
    );
    return (statusRows ?? []).map((row) => ({
      week: row.week,
      statuses: Number(row.statuses),
      registrations: registrations.get(row.week) ?? 0,
    }));
  });
