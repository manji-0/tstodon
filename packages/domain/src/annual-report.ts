import type { AnnualReportArchetype } from "@tstodon/api/values";

/** Mastodon 4.7's `AnnualReport::SCHEMA`: the shape of `data` a report is generated with. */
export const ANNUAL_REPORT_SCHEMA_VERSION = 2;

/**
 * `AnnualReport.current_campaign`: the year whose reports are offered at
 * `now`, from December 10 to 31 (UTC), else none.
 */
export const annualReportCampaign = (now: Date): number | undefined =>
  now.getUTCMonth() === 11 && now.getUTCDate() >= 10 ? now.getUTCFullYear() : undefined;

/**
 * The stored-timestamp bounds of `year` (UTC), `start` inclusive and `end`
 * exclusive. Stored instants (`2025-06-01T…Z` or `2025-06-01 …`) compare
 * against them as text.
 */
export const annualReportYearRange = (year: number): Readonly<{ start: string; end: string }> => ({
  start: `${String(year).padStart(4, "0")}-01-01`,
  end: `${String(year + 1).padStart(4, "0")}-01-01`,
});

/** An account's statuses of the year, as `AnnualReport::Archetype` counts them. */
export type AnnualReportPostCounts = Readonly<{
  /** Neither a boost nor a reply to another account (a self-reply counts). */
  standalone: number;
  /** Replies to another account. */
  replies: number;
  reblogs: number;
  /** Statuses with a poll, also counted in `standalone` or `replies`. */
  polls: number;
}>;

/** Mastodon's average number of posts, replies and boosts per active user in a year (2023). */
const AVERAGE_POSTS_PER_YEAR = 113;

/** `AnnualReport::Archetype#archetype`. */
export const annualReportArchetype = (counts: AnnualReportPostCounts): AnnualReportArchetype => {
  if (counts.standalone + counts.replies + counts.reblogs < AVERAGE_POSTS_PER_YEAR) {
    return "lurker";
  }
  if (counts.reblogs > counts.standalone * 2) {
    return "booster";
  }
  if (counts.polls > counts.standalone * 0.1) {
    return "pollster";
  }
  if (counts.replies > counts.standalone * 2) {
    return "replier";
  }
  return "oracle";
};

/** A generation request, as stored: when it was queued and when its job finished. */
export type AnnualReportGeneration = Readonly<{
  startedAt: Date;
  finishedAt: Date | undefined;
}>;

/** What Mastodon's `AsyncRefresh` for a report's generation reads. */
export type AnnualReportRefresh = Readonly<{ kind: "Running" }> | Readonly<{ kind: "Finished" }>;

/** `AsyncRefresh::NEW_REFRESH_EXPIRATION`: a refresh whose job never finishes is gone after a day. */
const RUNNING_FOR_MS = 24 * 60 * 60 * 1000;
/** `AsyncRefresh::FINISHED_REFRESH_EXPIRATION`. */
const FINISHED_FOR_MS = 60 * 60 * 1000;

/**
 * The refresh `generation` stands for at `now`: running from its start until
 * its job finishes, for at most a day; finished for an hour after that; then
 * none, as Mastodon's Redis key expires.
 */
export const annualReportRefresh = (
  generation: AnnualReportGeneration,
  now: Date,
): AnnualReportRefresh | undefined => {
  if (generation.finishedAt === undefined) {
    return now.getTime() - generation.startedAt.getTime() < RUNNING_FOR_MS
      ? { kind: "Running" }
      : undefined;
  }
  return now.getTime() - generation.finishedAt.getTime() < FINISHED_FOR_MS
    ? { kind: "Finished" }
    : undefined;
};
