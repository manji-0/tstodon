import { z } from "zod";
import { ApiAccount } from "./account";
import { ApiStatus } from "./status";
import { ANNUAL_REPORT_ARCHETYPES, ANNUAL_REPORT_STATES } from "./values";

/** A hashtag of `top_hashtags` (`AnnualReport::TopHashtags`). */
export const ApiAnnualReportHashtag = z.object({ name: z.string(), count: z.number() });
export type ApiAnnualReportHashtagJSON = z.infer<typeof ApiAnnualReportHashtag>;

/** A month of `time_series` (`AnnualReport::TimeSeries`): schema 2 sends only December, the year's totals. */
export const ApiAnnualReportMonth = z.object({
  month: z.number(),
  statuses: z.number(),
  followers: z.number(),
});
export type ApiAnnualReportMonthJSON = z.infer<typeof ApiAnnualReportMonth>;

/**
 * `data` of a schema 2 report, the sources of Mastodon 4.7's `AnnualReport`
 * merged. `top_statuses.by_favourites` and `by_replies` are always `null`
 * in schema 2.
 */
export const ApiAnnualReportData = z.object({
  archetype: z.literal(ANNUAL_REPORT_ARCHETYPES),
  top_statuses: z.object({
    by_reblogs: z.string().nullable(),
    by_favourites: z.string().nullable(),
    by_replies: z.string().nullable(),
  }),
  time_series: z.array(ApiAnnualReportMonth),
  top_hashtags: z.array(ApiAnnualReportHashtag),
});
export type ApiAnnualReportDataJSON = z.infer<typeof ApiAnnualReportData>;

/** `REST::AnnualReportSerializer`. */
export const ApiAnnualReport = z.object({
  year: z.number(),
  data: ApiAnnualReportData,
  schema_version: z.literal(2),
  share_url: z.string().nullable(),
  account_id: z.string(),
});
export type ApiAnnualReportJSON = z.infer<typeof ApiAnnualReport>;

/**
 * `REST::AnnualReportsSerializer` (`GET /api/v1/annual_reports` and
 * `/api/v1/annual_reports/:year`): the reports with the accounts and
 * statuses they name.
 */
export const ApiAnnualReports = z.object({
  annual_reports: z.array(ApiAnnualReport),
  accounts: z.array(ApiAccount),
  statuses: z.array(ApiStatus),
});
export type ApiAnnualReportsJSON = z.infer<typeof ApiAnnualReports>;

/** `GET /api/v1/annual_reports/:year/state`. */
export const ApiAnnualReportState = z.object({ state: z.literal(ANNUAL_REPORT_STATES) });
export type ApiAnnualReportStateJSON = z.infer<typeof ApiAnnualReportState>;
