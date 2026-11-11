import type {
  ApiAdminCohortJSON,
  ApiAdminDimensionDataJSON,
  ApiAdminDimensionJSON,
  ApiAdminMeasureJSON,
} from "@tstodon/api";
import type {
  AdminDimensionKey,
  AdminMeasureKey,
  AdminRetentionFrequency,
} from "@tstodon/api/values";
import { extractHashtags, Languages } from "@tstodon/core";
import { z } from "zod";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { dailyMediaAttachmentBytes as dailyMediaAttachmentBytesSql } from "./generated/prisma/sql";
import { humanSize } from "./human-size";
import { storedMediaBytes, totalStoredMediaBytes } from "./media-sizes";
import { queryTyped } from "./typed-sql";
import { err, ok, type Result } from "neverthrow";

/**
 * Mastodon's admin metrics (`Admin::Metrics::Measure`, `::Dimension`,
 * `::Retention`) computed from what D1 stores. Mastodon counts some of these
 * in Redis as they happen; here they are counted from the rows:
 *
 * - `active_users` and the retention cohorts read `account_activity_days`
 *   (migration 0124), which tstodon records from the day it was deployed, so
 *   days before that count no one;
 * - `interactions` counts favourites, boosts and replies of local posts, by
 *   local accounts and remote actors;
 * - `instance_media_attachments` and the `media` entry of `space_usage`
 *   sum the byte sizes recorded for what tstodon stores in the `MEDIA`
 *   bucket (migration 0125; sizes of objects stored before it count once
 *   `BackfillStoredMediaSizes` has read them). tstodon does not cache remote
 *   media, so the measure is 0 for any domain but this server's own;
 * - `sources` is every sign-up as `web`: accounts are created only by the
 *   web sign-in (Cloudflare Access), never by an app.
 */

const DAY_MS = 86_400_000;

/** The longest range one request may ask for, in days. */
export const MAX_RANGE_DAYS = 400;

/** A range of whole UTC days, both ends included. */
export type MetricsRange = Readonly<{ start: string; end: string }>;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const nextDay = (day: string): string => isoDay(dayMs(day) + DAY_MS);

/** Each day of the range, oldest first. */
const daysOf = (range: MetricsRange): string[] => {
  const days: string[] = [];
  for (let at = dayMs(range.start); at <= dayMs(range.end); at += DAY_MS) {
    days.push(isoDay(at));
  }
  return days;
};

/** The range of the same length just before `range`. */
const previousRange = (range: MetricsRange): MetricsRange => {
  const length = dayMs(range.end) - dayMs(range.start) + DAY_MS;
  return { start: isoDay(dayMs(range.start) - length), end: isoDay(dayMs(range.start) - DAY_MS) };
};

const midnight = (day: string): string => `${day}T00:00:00Z`;

export type RangeError = Readonly<{ kind: "InvalidRange"; message: string }>;

/**
 * `start_at` / `end_at` as UTC days. A missing end is today and a missing
 * start the 29 days before the end (Mastodon requires both; its dashboard
 * asks for the last 30 days).
 */
export const parseMetricsRange = (
  startAt: string | undefined,
  endAt: string | undefined,
  now: number = Date.now(),
): Result<MetricsRange, RangeError> => {
  const read = (raw: string | undefined): string | null | undefined => {
    const trimmed = raw?.trim() ?? "";
    if (trimmed.length === 0) {
      return undefined;
    }
    const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
    return Number.isFinite(ms) ? isoDay(ms) : null;
  };
  const end = read(endAt);
  const start = read(startAt);
  if (end === null || start === null) {
    return rangeError("start_at and end_at must be dates");
  }
  const endDay = end ?? isoDay(now);
  const startDay = start ?? isoDay(dayMs(endDay) - 29 * DAY_MS);
  if (dayMs(startDay) > dayMs(endDay)) {
    return rangeError("start_at must not be after end_at");
  }
  if ((dayMs(endDay) - dayMs(startDay)) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return rangeError(`the range may span at most ${MAX_RANGE_DAYS} days`);
  }
  return okRange({ start: startDay, end: endDay });
};

const rangeError = (message: string): Result<MetricsRange, RangeError> =>
  err({ kind: "InvalidRange", message });
const okRange = (range: MetricsRange): Result<MetricsRange, RangeError> => ok(range);

const DayCountRow = z.object({ day: z.string(), n: z.number() });
const CountRow = z.object({ n: z.number() });

type DailyCounts = ReadonlyMap<string, number>;

/** `SELECT substr(<column>, 1, 10) AS day, COUNT(...) AS n` grouped by day, over a range. */
const dailyCounts = async (
  db: D1Database,
  sql: string,
  binds: ReadonlyArray<string | number>,
): Promise<DailyCounts> => {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return new Map(parseRows(DayCountRow, results).map((row) => [row.day, row.n]));
};

const count = async (
  db: D1Database,
  sql: string,
  binds: ReadonlyArray<string | number>,
): Promise<number> => {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return parseRows(CountRow, results)[0]?.n ?? 0;
};

const seriesOf = (range: MetricsRange, daily: DailyCounts): ApiAdminMeasureJSON["data"] =>
  daysOf(range).map((day) => ({ date: midnight(day), value: String(daily.get(day) ?? 0) }));

const sum = (daily: DailyCounts): number => [...daily.values()].reduce((a, b) => a + b, 0);

/** A measure counted per day in time: its total, the previous range's, and the days. */
const timedMeasure = async (
  key: AdminMeasureKey,
  range: MetricsRange,
  daily: (range: MetricsRange) => Promise<DailyCounts>,
  total?: (range: MetricsRange) => Promise<number>,
): Promise<ApiAdminMeasureJSON> => {
  const previous = previousRange(range);
  const [current, before] = await Promise.all([daily(range), daily(previous)]);
  const [currentTotal, previousTotal] = total
    ? await Promise.all([total(range), total(previous)])
    : [sum(current), sum(before)];
  return {
    key,
    unit: null,
    total: String(currentTotal),
    previous_total: String(previousTotal),
    data: seriesOf(range, current),
  };
};

/** A measure whose total is everything stored, not the range (the `instance_*` ones). */
const storedMeasure = async (
  key: AdminMeasureKey,
  range: MetricsRange,
  daily: (range: MetricsRange) => Promise<DailyCounts>,
  total: () => Promise<number>,
): Promise<ApiAdminMeasureJSON> => {
  const [current, all] = await Promise.all([daily(range), total()]);
  return { key, unit: null, total: String(all), data: seriesOf(range, current) };
};

/** Range bounds for a text timestamp column: `>= start` and `< the day after end`. */
const bounds = (range: MetricsRange): [string, string] => [range.start, nextDay(range.end)];

/**
 * A remote actor's domain is its `host[:port]` authority. With
 * `include_subdomains`, subdomains of the domain match too.
 */
const domainCondition = (
  column: string,
  domain: string,
  includeSubdomains: boolean,
): Readonly<{ sql: string; binds: string[] }> => {
  const host = domain.trim().toLowerCase();
  const exact = `(lower(${column}) = ? OR lower(${column}) LIKE ? || ':%')`;
  if (!includeSubdomains) {
    return { sql: exact, binds: [host, host] };
  }
  return {
    sql: `(${exact} OR lower(${column}) LIKE '%.' || ? OR lower(${column}) LIKE '%.' || ? || ':%')`,
    binds: [host, host, host, host],
  };
};

const INTERACTIONS_SQL = `
  SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM (
    SELECT created_at AS at FROM favourites WHERE local_status_id IS NOT NULL
    UNION ALL
    SELECT created_at FROM remote_favourites
    UNION ALL
    SELECT created_at FROM remote_announces
    UNION ALL
    SELECT created_at FROM statuses WHERE kind <> 'LocalNote' AND reblog_of_id IS NOT NULL
    UNION ALL
    SELECT created_at FROM statuses WHERE kind = 'LocalNote' AND in_reply_to_id IS NOT NULL
  ) WHERE at >= ? AND at < ? GROUP BY day`;

/** One use of a tag: who, from where, when, in which language. */
type TagUse = Readonly<{ account: string; server: string; day: string; language: string | null }>;

const LocalTagRow = z.object({
  account_id: z.string(),
  created_at: z.string(),
  content_text: z.string(),
  language: z.string().nullable(),
});
const RemoteTagRow = z.object({
  actor_uri: z.string(),
  at: z.string(),
  language: z.string().nullable(),
  domain: z.string().nullable(),
});

/** Most rows of each origin read for one tag's metrics. */
const TAG_SCAN_LIMIT = 5000;

/**
 * The uses of `tag` in the range: local public and unlisted notes (which
 * keep no tag index, so their text is read) and indexed remote statuses.
 */
const tagUses = async (
  db: D1Database,
  tag: string,
  range: MetricsRange,
  localDomain: string,
): Promise<TagUse[]> => {
  const name = tag.trim().replace(/^#+/, "").toLowerCase();
  if (name.length === 0) {
    return [];
  }
  const [from, to] = bounds(range);
  const [local, remote] = await Promise.all([
    db
      .prepare(
        `SELECT account_id, created_at, content_text, language FROM statuses
         WHERE kind = 'LocalNote' AND visibility IN ('public', 'unlisted')
           AND created_at >= ? AND created_at < ? AND content_text LIKE ?
         ORDER BY id DESC LIMIT ?`,
      )
      .bind(from, to, `%#${name}%`, TAG_SCAN_LIMIT)
      .all(),
    db
      .prepare(
        `SELECT r.actor_uri, r.published_at AS at, r.language, a.domain
         FROM remote_status_tags t
         JOIN remote_statuses r ON r.id = t.status_id
         LEFT JOIN remote_actors a ON a.actor_uri = r.actor_uri
         WHERE t.tag = ? AND r.published_at >= ? AND r.published_at < ?
         LIMIT ?`,
      )
      .bind(name, from, to, TAG_SCAN_LIMIT)
      .all(),
  ]);
  return [
    ...parseRows(LocalTagRow, local.results)
      .filter((row) => extractHashtags(row.content_text).includes(name))
      .map((row) => ({
        account: row.account_id,
        server: localDomain,
        day: row.created_at.slice(0, 10),
        language: row.language,
      })),
    ...parseRows(RemoteTagRow, remote.results).map((row) => ({
      account: row.actor_uri,
      server: (row.domain ?? new URL(row.actor_uri).host).toLowerCase(),
      day: row.at.slice(0, 10),
      language: row.language,
    })),
  ];
};

/** Per day, how many distinct values of `pick` the uses have. */
const distinctDaily = (uses: ReadonlyArray<TagUse>, pick: (use: TagUse) => string): DailyCounts => {
  const byDay = new Map<string, Set<string>>();
  for (const use of uses) {
    const seen = byDay.get(use.day) ?? new Set<string>();
    seen.add(pick(use));
    byDay.set(use.day, seen);
  }
  return new Map([...byDay].map(([day, seen]) => [day, seen.size]));
};

const tagMeasure = async (
  db: D1Database,
  key: "tag_accounts" | "tag_uses" | "tag_servers",
  tag: string,
  range: MetricsRange,
  localDomain: string,
): Promise<ApiAdminMeasureJSON> => {
  const previous = previousRange(range);
  const [current, before] = await Promise.all([
    tagUses(db, tag, range, localDomain),
    tagUses(db, tag, previous, localDomain),
  ]);
  const summarize = (uses: ReadonlyArray<TagUse>): [DailyCounts, number] => {
    switch (key) {
      case "tag_uses": {
        const daily = new Map<string, number>();
        for (const use of uses) {
          daily.set(use.day, (daily.get(use.day) ?? 0) + 1);
        }
        return [daily, uses.length];
      }
      case "tag_accounts":
        return [
          distinctDaily(uses, (use) => use.account),
          new Set(uses.map((use) => use.account)).size,
        ];
      case "tag_servers":
        return [
          distinctDaily(uses, (use) => use.server),
          new Set(uses.map((use) => use.server)).size,
        ];
    }
  };
  const [daily, total] = summarize(current);
  const [, previousTotal] = summarize(before);
  return {
    key,
    unit: null,
    total: String(total),
    previous_total: String(previousTotal),
    data: seriesOf(range, daily),
  };
};

/** What each measure reads besides the range (`tag_*[id]`, `instance_*[domain]`). */
export type MeasureParams = Readonly<{
  tag?: string | undefined;
  domain?: string | undefined;
  includeSubdomains?: boolean | undefined;
}>;

const ACTOR_DOMAIN_SQL = (condition: string) =>
  `SELECT actor_uri FROM remote_actors WHERE ${condition}`;

/** One measure, or `undefined` when it lacks the parameter it needs. */
const measure = async (
  db: D1Database,
  key: AdminMeasureKey,
  range: MetricsRange,
  params: MeasureParams,
  localDomain: string,
): Promise<ApiAdminMeasureJSON> => {
  const day = (column: string) => `substr(${column}, 1, 10)`;
  switch (key) {
    case "new_users":
      return timedMeasure(key, range, (r) =>
        dailyCounts(
          db,
          `SELECT ${day("created_at")} AS day, COUNT(*) AS n FROM accounts
           WHERE created_at >= ? AND created_at < ? GROUP BY day`,
          bounds(r),
        ),
      );
    case "active_users":
      return timedMeasure(
        key,
        range,
        (r) =>
          dailyCounts(
            db,
            `SELECT day, COUNT(*) AS n FROM account_activity_days
             WHERE day >= ? AND day < ? GROUP BY day`,
            bounds(r),
          ),
        (r) =>
          count(
            db,
            `SELECT COUNT(DISTINCT account_id) AS n FROM account_activity_days
             WHERE day >= ? AND day < ?`,
            bounds(r),
          ),
      );
    case "interactions":
      return timedMeasure(key, range, (r) => dailyCounts(db, INTERACTIONS_SQL, bounds(r)));
    case "opened_reports":
      return timedMeasure(key, range, (r) =>
        dailyCounts(
          db,
          `SELECT ${day("created_at")} AS day, COUNT(*) AS n FROM reports
           WHERE created_at >= ? AND created_at < ? GROUP BY day`,
          bounds(r),
        ),
      );
    case "resolved_reports":
      return timedMeasure(key, range, (r) =>
        dailyCounts(
          db,
          `SELECT ${day("action_taken_at")} AS day, COUNT(*) AS n FROM reports
           WHERE action_taken_at >= ? AND action_taken_at < ? GROUP BY day`,
          bounds(r),
        ),
      );
    case "tag_accounts":
    case "tag_uses":
    case "tag_servers":
      return tagMeasure(db, key, params.tag ?? "", range, localDomain);
    case "instance_media_attachments":
      return mediaAttachmentsMeasure(db, range, params, localDomain);
    case "instance_accounts":
    case "instance_statuses":
    case "instance_follows":
    case "instance_followers":
    case "instance_reports":
      return instanceMeasure(db, key, range, params);
  }
};

/**
 * Whether `localDomain` is the `domain` asked for (or under it, with
 * `include_subdomains`).
 */
const isLocalDomain = (localDomain: string, params: MeasureParams): boolean => {
  const domain = params.domain?.trim().toLowerCase() ?? "";
  const local = localDomain.toLowerCase();
  return (
    domain.length > 0 &&
    (local === domain || (params.includeSubdomains === true && local.endsWith(`.${domain}`)))
  );
};

/**
 * `Admin::Metrics::Measure::InstanceMediaAttachmentsMeasure`: the bytes of a
 * domain's media attachments (original and preview) stored here, in total
 * and by the day they were uploaded. Mastodon counts the remote media it
 * caches; tstodon caches none (remote attachments are linked from their
 * server), so a remote domain stores 0 bytes. This server's own domain
 * counts its uploads.
 */
const mediaAttachmentsMeasure = async (
  db: D1Database,
  range: MetricsRange,
  params: MeasureParams,
  localDomain: string,
): Promise<ApiAdminMeasureJSON> => {
  const key = "instance_media_attachments";
  if (!isLocalDomain(localDomain, params)) {
    return {
      key,
      unit: "bytes",
      total: "0",
      human_value: humanSize(0),
      data: seriesOf(range, new Map()),
    };
  }
  const [from, to] = bounds(range);
  const [daily, stored] = await Promise.all([
    queryTyped(db, dailyMediaAttachmentBytesSql(from, to), DayCountRow),
    storedMediaBytes(db),
  ]);
  if (stored.isErr()) {
    throw new Error(stored.error.message);
  }
  return {
    key,
    unit: "bytes",
    total: String(stored.value.attachments),
    human_value: humanSize(stored.value.attachments),
    data: seriesOf(range, new Map(daily.map((row) => [row.day, row.n]))),
  };
};

const instanceMeasure = async (
  db: D1Database,
  key: Extract<
    AdminMeasureKey,
    | "instance_accounts"
    | "instance_statuses"
    | "instance_follows"
    | "instance_followers"
    | "instance_reports"
  >,
  range: MetricsRange,
  params: MeasureParams,
): Promise<ApiAdminMeasureJSON> => {
  const domain = params.domain?.trim() ?? "";
  if (domain.length === 0) {
    return { key, unit: null, total: "0", data: seriesOf(range, new Map()) };
  }
  const where = domainCondition("domain", domain, params.includeSubdomains === true);
  const actors = ACTOR_DOMAIN_SQL(where.sql);
  const queries: Record<typeof key, Readonly<{ table: string; column: string; filter: string }>> = {
    instance_accounts: { table: "remote_actors", column: "created_at", filter: where.sql },
    instance_statuses: {
      table: "remote_statuses",
      column: "published_at",
      filter: `actor_uri IN (${actors})`,
    },
    instance_follows: {
      table: "outbound_follows",
      column: "created_at",
      filter: `state = 'Accepted' AND actor_uri IN (${actors})`,
    },
    instance_followers: {
      table: "remote_follows",
      column: "created_at",
      filter: `follow_kind = 'Accepted' AND remote_actor_uri IN (${actors})`,
    },
    instance_reports: {
      table: "reports",
      column: "created_at",
      filter: `target_actor_uri IN (${actors})`,
    },
  };
  const { table, column, filter } = queries[key];
  return storedMeasure(
    key,
    range,
    (r) =>
      dailyCounts(
        db,
        `SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS n FROM ${table}
         WHERE ${filter} AND ${column} >= ? AND ${column} < ? GROUP BY day`,
        [...where.binds, ...bounds(r)],
      ),
    () => count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${filter}`, where.binds),
  );
};

/** Each requested measure, in the order asked; unknown keys were dropped by the caller. */
export const adminMeasures = async (
  db: D1Database,
  requests: ReadonlyArray<Readonly<{ key: AdminMeasureKey; params: MeasureParams }>>,
  range: MetricsRange,
  localDomain: string,
): Promise<Result<ApiAdminMeasureJSON[], RepositoryError>> =>
  runD1(() =>
    Promise.all(
      requests.map((request) => measure(db, request.key, range, request.params, localDomain)),
    ),
  );

const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map(
  Languages.map(([code, name]) => [code, name]),
);

const KeyCountRow = z.object({ key: z.string(), n: z.number() });

const keyCounts = async (
  db: D1Database,
  sql: string,
  binds: ReadonlyArray<string | number>,
): Promise<Array<Readonly<{ key: string; n: number }>>> => {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return parseRows(KeyCountRow, results);
};

const languageData = (
  rows: ReadonlyArray<Readonly<{ key: string; n: number }>>,
): ApiAdminDimensionDataJSON[] =>
  rows.map((row) => ({
    key: row.key,
    human_key: LANGUAGE_NAMES.get(row.key) ?? row.key,
    value: String(row.n),
  }));

const plainData = (
  rows: ReadonlyArray<Readonly<{ key: string; n: number }>>,
): ApiAdminDimensionDataJSON[] =>
  rows.map((row) => ({ key: row.key, human_key: row.key, value: String(row.n) }));

/** Counts per key from a list, largest first, at most `limit`. */
const topOf = (keys: ReadonlyArray<string>, limit: number): Array<{ key: string; n: number }> => {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, n]) => ({ key, n }))
    .toSorted((left, right) => right.n - left.n || left.key.localeCompare(right.key))
    .slice(0, limit);
};

/** The tstodon release this Worker reports in NodeInfo. */
const TSTODON_VERSION = "0.1.0";

const D1SizeMeta = z.object({ size_after: z.number().optional() }).loose();

const dimension = async (
  db: D1Database,
  key: AdminDimensionKey,
  range: MetricsRange,
  params: MeasureParams,
  limit: number,
  localDomain: string,
): Promise<ApiAdminDimensionJSON> => {
  const [from, to] = bounds(range);
  switch (key) {
    case "languages":
      return {
        key,
        data: languageData(
          await keyCounts(
            db,
            `SELECT language AS key, COUNT(*) AS n FROM statuses
             WHERE kind = 'LocalNote' AND language IS NOT NULL AND language <> ''
               AND created_at >= ? AND created_at < ?
             GROUP BY language ORDER BY n DESC, language LIMIT ?`,
            [from, to, limit],
          ),
        ),
      };
    case "sources": {
      const signUps = await count(
        db,
        `SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ? AND created_at < ?`,
        [from, to],
      );
      return {
        key,
        data: signUps > 0 ? [{ key: "web", human_key: "Website", value: String(signUps) }] : [],
      };
    }
    case "servers":
      return {
        key,
        data: plainData(
          await keyCounts(
            db,
            `SELECT lower(a.domain) AS key, COUNT(*) AS n FROM remote_statuses r
             JOIN remote_actors a ON a.actor_uri = r.actor_uri
             WHERE r.published_at >= ? AND r.published_at < ?
             GROUP BY lower(a.domain) ORDER BY n DESC, key LIMIT ?`,
            [from, to, limit],
          ),
        ),
      };
    case "space_usage": {
      // D1 reports the database size after each query; the bucket's share is
      // the sum of the recorded object sizes (Mastodon's `media` entry).
      const [result, stored] = await Promise.all([
        db.prepare("SELECT 1").all(),
        storedMediaBytes(db),
      ]);
      if (stored.isErr()) {
        throw new Error(stored.error.message);
      }
      const meta = D1SizeMeta.safeParse(result.meta);
      const bytes = meta.success ? (meta.data.size_after ?? 0) : 0;
      const media = totalStoredMediaBytes(stored.value);
      return {
        key,
        data: [
          {
            key: "d1",
            human_key: "Cloudflare D1",
            value: String(bytes),
            unit: "bytes",
            human_value: humanSize(bytes),
          },
          {
            key: "media",
            human_key: "Media storage",
            value: String(media),
            unit: "bytes",
            human_value: humanSize(media),
          },
        ],
      };
    }
    case "software_versions":
      return {
        key,
        data: [
          {
            key: "tstodon",
            human_key: "tstodon",
            value: TSTODON_VERSION,
            human_value: TSTODON_VERSION,
          },
        ],
      };
    case "tag_servers":
    case "tag_languages": {
      const uses = await tagUses(db, params.tag ?? "", range, localDomain);
      return key === "tag_servers"
        ? {
            key,
            data: plainData(
              topOf(
                uses.map((use) => use.server),
                limit,
              ),
            ),
          }
        : {
            key,
            data: languageData(
              topOf(
                uses.flatMap((use) => (use.language ? [use.language] : [])),
                limit,
              ),
            ),
          };
    }
    case "instance_accounts":
    case "instance_languages": {
      const domain = params.domain?.trim() ?? "";
      if (domain.length === 0) {
        return { key, data: [] };
      }
      const where = domainCondition("a.domain", domain, params.includeSubdomains === true);
      if (key === "instance_accounts") {
        // The domain's accounts most followed from here, as Mastodon's (by followers).
        return {
          key,
          data: plainData(
            await keyCounts(
              db,
              `SELECT a.username AS key, COUNT(f.id) AS n FROM remote_actors a
               LEFT JOIN outbound_follows f ON f.actor_uri = a.actor_uri AND f.state = 'Accepted'
               WHERE ${where.sql}
               GROUP BY a.actor_uri ORDER BY n DESC, a.username LIMIT ?`,
              [...where.binds, limit],
            ),
          ),
        };
      }
      return {
        key,
        data: languageData(
          await keyCounts(
            db,
            `SELECT r.language AS key, COUNT(*) AS n FROM remote_statuses r
             JOIN remote_actors a ON a.actor_uri = r.actor_uri
             WHERE ${where.sql} AND r.language IS NOT NULL AND r.language <> ''
               AND r.published_at >= ? AND r.published_at < ?
             GROUP BY r.language ORDER BY n DESC, r.language LIMIT ?`,
            [...where.binds, from, to, limit],
          ),
        ),
      };
    }
  }
};

export const adminDimensions = async (
  db: D1Database,
  requests: ReadonlyArray<Readonly<{ key: AdminDimensionKey; params: MeasureParams }>>,
  range: MetricsRange,
  limit: number,
  localDomain: string,
): Promise<Result<ApiAdminDimensionJSON[], RepositoryError>> =>
  runD1(() =>
    Promise.all(
      requests.map((request) =>
        dimension(db, request.key, range, request.params, limit, localDomain),
      ),
    ),
  );

/** The periods of a range: each day, or the first day of each month. */
const periodsOf = (range: MetricsRange, frequency: AdminRetentionFrequency): string[] => {
  if (frequency === "day") {
    return daysOf(range);
  }
  const periods: string[] = [];
  let cursor = `${range.start.slice(0, 7)}-01`;
  while (dayMs(cursor) <= dayMs(range.end)) {
    periods.push(cursor);
    const date = new Date(dayMs(cursor));
    cursor = isoDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  return periods;
};

/** The period a day falls in. */
const periodOf = (day: string, frequency: AdminRetentionFrequency): string =>
  frequency === "day" ? day : `${day.slice(0, 7)}-01`;

const CohortMemberRow = z.object({ id: z.string(), created_at: z.string() });
const ActivityRow = z.object({ account_id: z.string(), day: z.string() });

/**
 * `Admin::Metrics::Retention`: for each period of the range, the local
 * accounts that signed up in it, and the share of them active in that period
 * and each one after it up to the range's end. Signing up counts as being
 * active in the sign-up period.
 */
export const adminRetention = async (
  db: D1Database,
  range: MetricsRange,
  frequency: AdminRetentionFrequency,
): Promise<Result<ApiAdminCohortJSON[], RepositoryError>> =>
  runD1(async () => {
    const periods = periodsOf(range, frequency);
    const first = periods[0] ?? range.start;
    const [from, to] = [first, nextDay(range.end)];
    const [members, activity] = await Promise.all([
      db
        .prepare(`SELECT id, created_at FROM accounts WHERE created_at >= ? AND created_at < ?`)
        .bind(from, to)
        .all(),
      db
        .prepare(
          `SELECT d.account_id, d.day FROM account_activity_days d
           JOIN accounts a ON a.id = d.account_id
           WHERE a.created_at >= ? AND a.created_at < ? AND d.day >= ? AND d.day < ?`,
        )
        .bind(from, to, from, to)
        .all(),
    ]);
    const cohortOf = new Map(
      parseRows(CohortMemberRow, members.results).map((row) => [
        row.id,
        periodOf(row.created_at.slice(0, 10), frequency),
      ]),
    );
    // Active accounts per (cohort, period).
    const active = new Map<string, Set<string>>();
    const mark = (cohort: string, period: string, accountId: string) => {
      const key = `${cohort}|${period}`;
      const seen = active.get(key) ?? new Set<string>();
      seen.add(accountId);
      active.set(key, seen);
    };
    for (const [accountId, cohort] of cohortOf) {
      mark(cohort, cohort, accountId);
    }
    for (const row of parseRows(ActivityRow, activity.results)) {
      const cohort = cohortOf.get(row.account_id);
      if (cohort !== undefined) {
        mark(cohort, periodOf(row.day, frequency), row.account_id);
      }
    }
    const sizes = new Map<string, number>();
    for (const cohort of cohortOf.values()) {
      sizes.set(cohort, (sizes.get(cohort) ?? 0) + 1);
    }
    return periods.map((period, index) => {
      const size = sizes.get(period) ?? 0;
      return {
        period: midnight(period),
        frequency,
        data: periods.slice(index).map((later) => {
          const value = active.get(`${period}|${later}`)?.size ?? 0;
          return {
            date: midnight(later),
            rate: size === 0 ? 0 : value / size,
            value: String(value),
          };
        }),
      };
    });
  });
