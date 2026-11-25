import {
  ApiAnnualReportData,
  type AnnualReportState,
  type ApiAnnualReportDataJSON,
} from "@tstodon/api";
import {
  ANNUAL_REPORT_SCHEMA_VERSION,
  type AnnualReportGeneration,
  type AnnualReportRefresh,
  annualReportArchetype,
  annualReportCampaign,
  annualReportRefresh,
  annualReportYearRange,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { okValues, parseRow, parseRows, type RepositoryError, runD1, runD1Batch } from "./d1";
import { newEntityId } from "./ids";
import { parseJsonColumn } from "./json-column";

/** A generated report (`GeneratedAnnualReport`), schema 2. */
export type AnnualReport = Readonly<{
  accountId: string;
  year: number;
  data: ApiAnnualReportDataJSON;
  shareKey: string | undefined;
}>;

const ReportRow = z.object({
  account_id: z.string(),
  year: z.number(),
  schema_version: z.literal(ANNUAL_REPORT_SCHEMA_VERSION),
  data_json: z.string(),
  share_key: z.string().nullable(),
});

const reportOf = (row: z.infer<typeof ReportRow>): Result<AnnualReport, RepositoryError> =>
  parseJsonColumn(ApiAnnualReportData, row.data_json).map((data) => ({
    accountId: row.account_id,
    year: row.year,
    data,
    shareKey: row.share_key ?? undefined,
  }));

const REPORT_COLUMNS = "account_id, year, schema_version, data_json, share_key";

/** The account's report of `year`, if one was generated. */
export const findAnnualReport = async (
  db: D1Database,
  accountId: string,
  year: number,
): Promise<Result<AnnualReport | undefined, RepositoryError>> => {
  const row = await runD1(() =>
    db
      .prepare(
        `SELECT ${REPORT_COLUMNS} FROM generated_annual_reports WHERE account_id = ? AND year = ?`,
      )
      .bind(accountId, year)
      .first(),
  );
  if (row.isErr()) {
    return err(row.error);
  }
  if (row.value === null) {
    return ok(undefined);
  }
  return parseRow(ReportRow, row.value).andThen(reportOf);
};

/** The account's reports it has not viewed yet (`GeneratedAnnualReport.pending`), oldest year first. */
export const listPendingAnnualReports = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<AnnualReport>, RepositoryError>> => {
  const rows = await runD1(async () =>
    parseRows(
      ReportRow,
      (
        await db
          .prepare(
            `SELECT ${REPORT_COLUMNS} FROM generated_annual_reports
             WHERE account_id = ? AND viewed_at IS NULL ORDER BY year`,
          )
          .bind(accountId)
          .all()
      ).results,
    ),
  );
  // A report whose data does not parse is left out, as `parseRows` leaves out a bad row.
  return rows.map((found) => okValues(found.map(reportOf)));
};

/** `GeneratedAnnualReport#view!`; false when the account has no report of `year`. */
export const markAnnualReportViewed = async (
  db: D1Database,
  accountId: string,
  year: number,
  now: Date,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await db
      .prepare(
        `UPDATE generated_annual_reports SET viewed_at = ?3, updated_at = ?3
         WHERE account_id = ?1 AND year = ?2`,
      )
      .bind(accountId, year, now.toISOString())
      .run();
    return result.meta.changes > 0;
  });

const GenerationRow = z.object({ started_at: z.string(), finished_at: z.string().nullable() });

/** The last generation started for the account's report of `year`, if any. */
export const findAnnualReportGeneration = async (
  db: D1Database,
  accountId: string,
  year: number,
): Promise<Result<AnnualReportGeneration | undefined, RepositoryError>> => {
  const row = await runD1(() =>
    db
      .prepare(
        `SELECT started_at, finished_at FROM annual_report_generations
         WHERE account_id = ? AND year = ?`,
      )
      .bind(accountId, year)
      .first(),
  );
  if (row.isErr()) {
    return err(row.error);
  }
  if (row.value === null) {
    return ok(undefined);
  }
  return parseRow(GenerationRow, row.value).map((generation) => ({
    startedAt: new Date(generation.started_at),
    finishedAt: generation.finished_at === null ? undefined : new Date(generation.finished_at),
  }));
};

/** Start (or start again) the generation of the account's report of `year`. */
export const startAnnualReportGeneration = async (
  db: D1Database,
  accountId: string,
  year: number,
  now: Date,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO annual_report_generations (account_id, year, started_at, finished_at)
         VALUES (?1, ?2, ?3, NULL)
         ON CONFLICT (account_id, year) DO UPDATE SET started_at = ?3, finished_at = NULL`,
      )
      .bind(accountId, year, now.toISOString())
      .run();
  });

/** A status of the account's year (`AnnualReport::Source#report_statuses`). */
const YEAR_STATUSES = "account_id = ?1 AND created_at >= ?2 AND created_at < ?3";
/**
 * Whether a status answers another (Mastodon's `reply`): a local parent, a
 * remote one, or a parent no longer held whose author was recorded.
 */
const IS_REPLY = `(in_reply_to_id IS NOT NULL OR in_reply_to_uri IS NOT NULL
  OR in_reply_to_account_id IS NOT NULL OR in_reply_to_actor_uri IS NOT NULL)`;
const DISTRIBUTABLE = "visibility IN ('public', 'unlisted')";

const EligibleRow = z.object({ distributable: z.number(), tagged: z.number() });

/**
 * `AnnualReport#eligible?`: every source is. `TopStatuses` needs a public or
 * unlisted status of the year, `TopHashtags` a status with a hashtag;
 * `Archetype` and `TimeSeries` take any account.
 */
export const annualReportEligible = async (
  db: D1Database,
  accountId: string,
  year: number,
): Promise<Result<boolean, RepositoryError>> => {
  const { start, end } = annualReportYearRange(year);
  const row = await runD1(() =>
    db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM statuses WHERE ${YEAR_STATUSES} AND ${DISTRIBUTABLE}) AS distributable,
           EXISTS (SELECT 1 FROM statuses s JOIN local_status_tags t ON t.status_id = s.id
                   WHERE s.account_id = ?1 AND s.created_at >= ?2 AND s.created_at < ?3) AS tagged`,
      )
      .bind(accountId, start, end)
      .first(),
  );
  return row.andThen((value) =>
    parseRow(EligibleRow, value).map((found) => found.distributable === 1 && found.tagged === 1),
  );
};

const CountsRow = z.object({
  statuses: z.number(),
  standalone: z.number(),
  replies: z.number(),
  reblogs: z.number(),
  polls: z.number(),
  followers: z.number(),
});
const TopStatusRow = z.object({ id: z.string() });
const TopHashtagRow = z.object({ name: z.string(), count: z.number() });

/**
 * The report's `data`, each source of Mastodon 4.7's `AnnualReport` read from
 * the account's statuses and follows of the year, in one batch of three
 * statements however much the account posted.
 */
const readAnnualReportData = async (
  db: D1Database,
  accountId: string,
  year: number,
): Promise<Result<ApiAnnualReportDataJSON, RepositoryError>> => {
  const { start, end } = annualReportYearRange(year);
  const read = await runD1Batch(db, [
    // `Archetype` and `TimeSeries`. A follow counts in the year it was made
    // (accepted, for a request), as Mastodon's `passive_relationships`.
    db
      .prepare(
        `SELECT
           COUNT(*) AS statuses,
           COALESCE(SUM(kind <> 'LocalReblog'
             AND (NOT ${IS_REPLY} OR in_reply_to_account_id = ?1)), 0) AS standalone,
           COALESCE(SUM(${IS_REPLY}
             AND (in_reply_to_actor_uri IS NOT NULL OR in_reply_to_account_id <> ?1)), 0) AS replies,
           COALESCE(SUM(kind = 'LocalReblog'), 0) AS reblogs,
           COALESCE(SUM(poll_id IS NOT NULL), 0) AS polls,
           (SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND kind = 'Accepted'
              AND created_at >= ?2 AND created_at < ?3)
           + (SELECT COUNT(*) FROM remote_follows WHERE target_account_id = ?1
              AND follow_kind = 'Accepted' AND created_at >= ?2 AND created_at < ?3) AS followers
         FROM statuses WHERE ${YEAR_STATUSES}`,
      )
      .bind(accountId, start, end),
    // `TopStatuses`: the most boosted public or unlisted status. Mastodon
    // leaves a tie to the database; the oldest wins here.
    db
      .prepare(
        `SELECT s.id FROM statuses s JOIN status_stats st ON st.status_id = s.id
         WHERE s.account_id = ?1 AND s.created_at >= ?2 AND s.created_at < ?3
           AND s.${DISTRIBUTABLE}
         ORDER BY st.reblogs_count DESC, s.id LIMIT 1`,
      )
      .bind(accountId, start, end),
    // `TopHashtags`: the hashtag used most, if used more than once.
    db
      .prepare(
        `SELECT COALESCE(tg.display_name, t.tag) AS name, COUNT(*) AS count
         FROM statuses s JOIN local_status_tags t ON t.status_id = s.id
         LEFT JOIN tags tg ON tg.name = t.tag
         WHERE s.account_id = ?1 AND s.created_at >= ?2 AND s.created_at < ?3
         GROUP BY COALESCE(tg.display_name, t.tag) HAVING COUNT(*) > 1
         ORDER BY count DESC, name LIMIT 1`,
      )
      .bind(accountId, start, end),
  ]);
  if (read.isErr()) {
    return err(read.error);
  }
  const [countsResult, topStatusResult, topHashtagResult] = read.value;
  const counts = parseRows(CountsRow, countsResult?.results)[0];
  if (!counts) {
    return err({ kind: "RepositoryError", message: "annual report counts returned no row" });
  }
  const topStatus = parseRows(TopStatusRow, topStatusResult?.results)[0];
  const topHashtags = parseRows(TopHashtagRow, topHashtagResult?.results);
  return ok({
    archetype: annualReportArchetype(counts),
    top_statuses: { by_reblogs: topStatus?.id ?? null, by_favourites: null, by_replies: null },
    time_series: [{ month: 12, statuses: counts.statuses, followers: counts.followers }],
    top_hashtags: topHashtags.map(({ name, count }) => ({ name, count })),
  });
};

/** `SecureRandom.hex(8)`: the share page's key. */
const newShareKey = (): string =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * `AnnualReport#generate`: store the account's report of `year` unless one
 * exists, and mark its generation finished. Running it again changes
 * nothing but the generation's finish time.
 */
export const generateAnnualReport = async (
  db: D1Database,
  accountId: string,
  year: number,
  now: Date,
): Promise<Result<void, RepositoryError>> => {
  const existing = await findAnnualReport(db, accountId, year);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const at = now.toISOString();
  const finish = db
    .prepare(
      `UPDATE annual_report_generations SET finished_at = ?3
       WHERE account_id = ?1 AND year = ?2 AND finished_at IS NULL`,
    )
    .bind(accountId, year, at);
  if (existing.value) {
    return (await runD1Batch(db, [finish])).map(() => undefined);
  }
  const data = await readAnnualReportData(db, accountId, year);
  if (data.isErr()) {
    return err(data.error);
  }
  // The account may be gone by now: the insert then stores nothing, as
  // Mastodon's worker gives up on `RecordNotFound`.
  const stored = await runD1Batch(db, [
    db
      .prepare(
        `INSERT OR IGNORE INTO generated_annual_reports
           (id, account_id, year, schema_version, data_json, share_key, viewed_at, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7 FROM accounts WHERE id = ?2`,
      )
      .bind(
        newEntityId(),
        accountId,
        year,
        ANNUAL_REPORT_SCHEMA_VERSION,
        JSON.stringify(data.value),
        newShareKey(),
        at,
      ),
    finish,
  ]);
  return stored.map(() => undefined);
};

/** The refresh of the account's report of `year`, if one is running or just finished. */
export const findAnnualReportRefresh = async (
  db: D1Database,
  accountId: string,
  year: number,
  now: Date,
): Promise<Result<AnnualReportRefresh | undefined, RepositoryError>> =>
  (await findAnnualReportGeneration(db, accountId, year)).map((generation) =>
    generation ? annualReportRefresh(generation, now) : undefined,
  );

/** `AnnualReport#state` at `now`. */
export const annualReportState = async (
  db: D1Database,
  accountId: string,
  year: number,
  now: Date,
): Promise<Result<AnnualReportState, RepositoryError>> => {
  const report = await findAnnualReport(db, accountId, year);
  if (report.isErr()) {
    return err(report.error);
  }
  if (report.value) {
    return ok("available");
  }
  const refresh = await findAnnualReportRefresh(db, accountId, year, now);
  if (refresh.isErr()) {
    return err(refresh.error);
  }
  if (refresh.value?.kind === "Running") {
    return ok("generating");
  }
  if (annualReportCampaign(now) !== year) {
    return ok("ineligible");
  }
  return (await annualReportEligible(db, accountId, year)).map((eligible) =>
    eligible ? "eligible" : "ineligible",
  );
};
