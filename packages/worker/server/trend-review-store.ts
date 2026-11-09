import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { z } from "zod";
import { parseRows, runD1, type RepositoryError } from "./d1";

/**
 * The trend families Mastodon lets a moderator review: tags, links,
 * statuses, and link publishers (`PreviewCardProvider`, named by host).
 */
export const TrendKinds = ["Tag", "Link", "Status", "Publisher"] as const;
export type TrendKind = (typeof TrendKinds)[number];

const TrendReviewRow = z.object({ target: z.string(), state: z.string() });

export type TrendState = "Approved" | "Rejected";

/**
 * The review decision for one trend target: the tag name, the link URL, or the
 * status id. No row means the target is still unreviewed.
 */
export const listTrendReviews = async (
  db: D1Database,
  kind: TrendKind,
): Promise<Result<ReadonlyMap<string, TrendState>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT target, state FROM trend_reviews WHERE kind = ?")
      .bind(kind)
      .all();
    return new Map(
      parseRows(TrendReviewRow, results).flatMap(({ target, state }): [string, TrendState][] =>
        state === "Approved" || state === "Rejected" ? [[target, state]] : [],
      ),
    );
  });

/** The rejected targets of one family, for the public trends lists. */
export const rejectedTrendTargets = async (
  db: D1Database,
  kind: TrendKind,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const reviews = await listTrendReviews(db, kind);
  if (reviews.isErr()) {
    return err(reviews.error);
  }
  return ok(
    new Set(
      [...reviews.value.entries()]
        .filter(([, state]) => state === "Rejected")
        .map(([target]) => target),
    ),
  );
};

/** Record a moderator decision (`Approved` or `Rejected`) for one target. */
export const setTrendReview = async (
  db: D1Database,
  kind: TrendKind,
  target: string,
  state: TrendState,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO trend_reviews (kind, target, state, reviewed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, target) DO UPDATE SET
           state = excluded.state,
           reviewed_at = excluded.reviewed_at`,
      )
      .bind(kind, target, state, nowIso())
      .run();
  });

const TrendReviewRecordRow = z.object({
  target: z.string(),
  state: z.string(),
  reviewed_at: z.string(),
});

export type TrendReviewRecord = Readonly<{ state: TrendState; reviewedAt: string }>;

/** {@link listTrendReviews} with when each decision was made. */
export const listTrendReviewRecords = async (
  db: D1Database,
  kind: TrendKind,
): Promise<Result<ReadonlyMap<string, TrendReviewRecord>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT target, state, reviewed_at FROM trend_reviews WHERE kind = ?")
      .bind(kind)
      .all();
    return new Map(
      parseRows(TrendReviewRecordRow, results).flatMap(
        ({ target, state, reviewed_at }): [string, TrendReviewRecord][] =>
          state === "Approved" || state === "Rejected"
            ? [[target, { state, reviewedAt: reviewed_at }]]
            : [],
      ),
    );
  });
