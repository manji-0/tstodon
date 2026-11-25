import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, parseRows, runD1, sqlInJsonEach, type RepositoryError } from "./d1";
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

/** The providers of the domains bound as a JSON array, each a seek on the unique `domain`. */
export const PREVIEW_CARD_PROVIDERS_BY_DOMAIN_SQL = `SELECT ${COLUMNS} FROM preview_card_providers WHERE domain ${sqlInJsonEach()}`;

/** A DNS name holds at most 127 labels, so no provider's domain has more. */
const MAX_DOMAIN_LABELS = 127;

/** `DomainNormalizable.domain_variants`: the host, then each of its parent domains. */
const domainVariants = (host: string): string[] => {
  const labels = host.split(".").slice(-MAX_DOMAIN_LABELS);
  return labels.map((_, index) => labels.slice(index).join("."));
};

/**
 * Each host's provider, as `PreviewCardProvider.matching_domain`: the row of
 * the longest of the host and its parent domains that has one. A host no row
 * matches has no entry.
 */
const matchPreviewCardProviders = async (
  db: D1Database,
  hosts: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, PreviewCardProviderRow>, RepositoryError>> => {
  const unique = [...new Set(hosts)];
  if (unique.length === 0) {
    return ok(new Map());
  }
  return runD1(async () => {
    const candidates = new Set(unique.flatMap(domainVariants));
    const { results } = await db
      .prepare(PREVIEW_CARD_PROVIDERS_BY_DOMAIN_SQL)
      .bind(jsonStringArray([...candidates]))
      .all();
    const byDomain = new Map(
      parseRows(PreviewCardProviderRow, results).map((row) => [row.domain, row]),
    );
    const matched = new Map<string, PreviewCardProviderRow>();
    for (const host of unique) {
      const row = domainVariants(host)
        .map((domain) => byDomain.get(domain))
        .find((candidate) => candidate !== undefined);
      if (row !== undefined) {
        matched.set(host, row);
      }
    }
    return matched;
  });
};

/** The hosts among `hosts` whose provider a moderator rejected: none of their links trend. */
export const rejectedPublisherHosts = async (
  db: D1Database,
  hosts: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> =>
  (await matchPreviewCardProviders(db, hosts)).map(
    (matched) =>
      new Set([...matched].filter(([, row]) => row.trendable === 0).map(([host]) => host)),
  );

/**
 * Write a provider for each host whose links trend now and that no provider
 * matches, as `Trends::Links#request_review` creates one with
 * `requested_review_at`. A host that a row matches, its own or a parent
 * domain's, keeps it as it is.
 */
export const recordTrendingPreviewCardProviders = async (
  db: D1Database,
): Promise<Result<void, RepositoryError>> => {
  const trending = await trendingLinkPublishers(db);
  if (trending.isErr()) {
    return err(trending.error);
  }
  const hosts = trending.value.map((publisher) => publisher.domain);
  const matched = await matchPreviewCardProviders(db, hosts);
  if (matched.isErr()) {
    return err(matched.error);
  }
  const unmatched = hosts.filter((host) => !matched.value.has(host));
  if (unmatched.length === 0) {
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
      .bind(now, jsonStringArray(unmatched))
      .run();
  });
};
