import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, parseRows, runD1, type RepositoryError } from "./d1";
import { type IdCursor, idCursorFragment, newestFirst } from "./id-cursor";
import { trendingLinkPublishers } from "./trend-store";

/** A `preview_card_providers` row: Mastodon's `PreviewCardProvider`. */
export const PreviewCardProviderRow = z.object({
  id: z.number().int(),
  domain: z.string(),
  trendable: z.number().nullable(),
  reviewed_at: z.string().nullable(),
  requested_review_at: z.string().nullable(),
});
export type PreviewCardProviderRow = z.infer<typeof PreviewCardProviderRow>;

const COLUMNS = "id, domain, trendable, reviewed_at, requested_review_at";

/**
 * Write a provider for each host whose links trend now and has none, as
 * `Trends::Links#request_review` creates one with `requested_review_at`.
 * A host that has a row keeps it as it is.
 */
export const recordTrendingPreviewCardProviders = async (
  db: D1Database,
): Promise<Result<void, RepositoryError>> => {
  const trending = await trendingLinkPublishers(db);
  if (trending.isErr()) {
    return err(trending.error);
  }
  if (trending.value.length === 0) {
    return ok(undefined);
  }
  return runD1(async () => {
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO preview_card_providers (domain, requested_review_at, created_at, updated_at)
         SELECT value, ?1, ?1, ?1 FROM json_each(?2) WHERE true
         ON CONFLICT(domain) DO NOTHING`,
      )
      .bind(now, jsonStringArray(trending.value.map((publisher) => publisher.domain)))
      .run();
  });
};

/** A page of providers, as `PreviewCardProvider.all.to_a_paginated_by_id`: newest id first. */
export const listPreviewCardProviders = async (
  db: D1Database,
  cursor: IdCursor,
  limit: number,
): Promise<Result<PreviewCardProviderRow[], RepositoryError>> =>
  runD1(async () => {
    const fragment = idCursorFragment(cursor);
    const { results } = await db
      .prepare(
        `SELECT ${COLUMNS} FROM preview_card_providers
         WHERE true ${fragment.where} ${fragment.order} LIMIT ?`,
      )
      .bind(...fragment.binds, limit)
      .all();
    return newestFirst(cursor, parseRows(PreviewCardProviderRow, results));
  });

/**
 * Approve (`trendable`) or reject a provider, as the API's `approve` and
 * `reject` do: `update(trendable:, reviewed_at: Time.now.utc)`. `undefined`
 * when there is no provider with that id.
 */
export const reviewPreviewCardProvider = async (
  db: D1Database,
  id: number,
  trendable: boolean,
): Promise<Result<PreviewCardProviderRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const now = nowIso();
    const { results } = await db
      .prepare(
        `UPDATE preview_card_providers SET trendable = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? RETURNING ${COLUMNS}`,
      )
      .bind(trendable ? 1 : 0, now, now, id)
      .all();
    return parseRows(PreviewCardProviderRow, results)[0];
  });

/** The hosts of the providers a moderator rejected: none of their links trend. */
export const rejectedPreviewCardProviderDomains = async (
  db: D1Database,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare("SELECT domain FROM preview_card_providers WHERE trendable = 0")
      .all();
    return new Set(parseRows(z.object({ domain: z.string() }), results).map((row) => row.domain));
  });
