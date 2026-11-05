import { z } from "zod";
import { InstanceLimits } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import {
  countAccountTagUses as countAccountTagUsesSql,
  countFeaturedTags as countFeaturedTagsSql,
  featureTag as featureTagSql,
  followTag as followTagSql,
  isTagFeatured as isTagFeaturedSql,
  isTagFollowed as isTagFollowedSql,
  listFeaturedTags as listFeaturedTagsSql,
  listFollowedTags as listFollowedTagsSql,
  searchTags as searchTagsSql,
  unfeatureTag as unfeatureTagSql,
  unfollowTag as unfollowTagSql,
} from "./generated/prisma/sql";
import { extractHashtags, hashtagUses, recordTagNames } from "./hashtags";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

const TagNameRow = z.object({ tag_name: z.string() });
const CountRow = z.object({ count: z.union([z.number(), z.bigint()]) });
const CountLastStatusAtRow = z.object({
  count: z.union([z.number(), z.bigint()]),
  last_status_at: z.string().nullable(),
});

export type TagHistoryEntry = Readonly<{ day: string; uses: string; accounts: string }>;

/** Mastodon's `FeaturedTag::LIMIT`, shared with the instance document. */
export const FEATURED_TAG_LIMIT = InstanceLimits.account.maxFeaturedTags;

const TAG_HISTORY_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

/** Normalize a tag to its stored form: no leading `#`, lowercase. */
export const normalizeTag = (raw: string): string => raw.trim().replace(/^#+/, "").toLowerCase();

export const isValidTag = (tag: string): boolean => /^[a-z0-9_]+$/.test(tag);

const NameRow = z.object({ name: z.string() });

/**
 * A search term as Mastodon's `HashtagNormalizer` reads it: NFKC, lowercase,
 * and only the characters a hashtag can hold, so `#Cat` and `cat!` are `cat`.
 */
export const tagSearchPrefix = (term: string): string =>
  term
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\u00B7\u30FB\u200C]/gu, "");

/**
 * Stored tags whose name starts with the term, as Mastodon's `Tag.search_for`:
 * shortest first, then by name, paged by `limit` and `offset`.
 */
export const searchTags = async (
  db: D1Database,
  term: string,
  limit: number,
  offset: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, searchTagsSql(tagSearchPrefix(term), limit, offset), NameRow);
    return rows.map((row) => row.name);
  });

export const followTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<void, RepositoryError>> =>
  // As Mastodon's `Tag.find_or_create_by_names`, the tag exists from now on.
  (
    await runD1Batch(db, [
      d1PrepareTyped(db, followTagSql(accountId, tag, nowIso())),
      ...recordTagNames(db, [tag]),
    ])
  ).map(() => undefined);

export const unfollowTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, unfollowTagSql(accountId, tag), TagNameRow);
    return rows.length > 0;
  });

export const isTagFollowed = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, isTagFollowedSql(accountId, tag), TagNameRow);
    return rows.length > 0;
  });

export const listFollowedTags = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listFollowedTagsSql(accountId), TagNameRow);
    return rows.map((row) => row.tag_name);
  });

export const featureTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<void, RepositoryError>> =>
  // As Mastodon's `Tag.find_or_create_by_names`, the tag exists from now on.
  (
    await runD1Batch(db, [
      d1PrepareTyped(db, featureTagSql(accountId, tag, nowIso())),
      ...recordTagNames(db, [tag]),
    ])
  ).map(() => undefined);

export const unfeatureTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, unfeatureTagSql(accountId, tag), TagNameRow);
    return rows.length > 0;
  });

export const isTagFeatured = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, isTagFeaturedSql(accountId, tag), TagNameRow);
    return rows.length > 0;
  });

export const listFeaturedTags = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listFeaturedTagsSql(accountId), TagNameRow);
    return rows.map((row) => row.tag_name);
  });

export const countFeaturedTags = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, countFeaturedTagsSql(accountId), CountRow);
    return Number(rows[0]?.count ?? 0);
  });

/** Public status count and last use of a tag by one account. */
export const accountTagUses = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<{ count: number; lastStatusAt: string | null }, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      countAccountTagUsesSql(accountId, `%#${tag}%`),
      CountLastStatusAtRow,
    );
    const row = rows[0];
    return { count: Number(row?.count ?? 0), lastStatusAt: row?.last_status_at ?? null };
  });

/**
 * Each tag's history: one entry per UTC day for the last week, newest first,
 * zero-filled. All tags share one scan of the week's recent public statuses.
 */
export const tagDailyHistories = async (
  db: D1Database,
  tags: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, TagHistoryEntry[]>, RepositoryError>> =>
  runD1(async () => {
    const wanted = new Set(tags);
    if (wanted.size === 0) {
      return new Map<string, TagHistoryEntry[]>();
    }
    const since = new Date(Date.now() - TAG_HISTORY_DAYS * SECONDS_PER_DAY * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT content_text, created_at, account_id FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' AND created_at >= ?
         ORDER BY id DESC LIMIT 1000`,
      )
      .bind(since)
      .all<{ content_text: string; created_at: string; account_id: string }>();
    // Keyed by tag, then by UTC day (epoch seconds).
    const uses = new Map<string, Map<string, number>>();
    const accounts = new Map<string, Map<string, Set<string>>>();
    for (const row of results ?? []) {
      const day = Math.floor(Date.parse(row.created_at) / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      if (!Number.isFinite(day)) {
        continue;
      }
      const key = String(day);
      for (const tag of new Set(extractHashtags(row.content_text))) {
        if (!wanted.has(tag)) {
          continue;
        }
        const tagUses = uses.get(tag) ?? new Map<string, number>();
        tagUses.set(key, (tagUses.get(key) ?? 0) + 1);
        uses.set(tag, tagUses);
        const tagAccounts = accounts.get(tag) ?? new Map<string, Set<string>>();
        const seen = tagAccounts.get(key) ?? new Set<string>();
        seen.add(row.account_id);
        tagAccounts.set(key, seen);
        accounts.set(tag, tagAccounts);
      }
    }
    const today = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const days = Array.from({ length: TAG_HISTORY_DAYS }, (_, offset) =>
      String(today - offset * SECONDS_PER_DAY),
    );
    return new Map(
      [...wanted].map((tag): [string, TagHistoryEntry[]] => [
        tag,
        days.map((day) => ({
          day,
          uses: String(uses.get(tag)?.get(day) ?? 0),
          accounts: String(accounts.get(tag)?.get(day)?.size ?? 0),
        })),
      ]),
    );
  });

/** {@link tagDailyHistories} for a single tag. */
export const tagDailyHistory = async (
  db: D1Database,
  tag: string,
): Promise<Result<TagHistoryEntry[], RepositoryError>> =>
  (await tagDailyHistories(db, [tag])).map((histories) => histories.get(tag) ?? []);

/** Tags the account has used publicly but has not featured yet. */
export const featuredTagSuggestions = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<string[], RepositoryError>> => {
  const featured = await listFeaturedTags(db, accountId);
  if (featured.isErr()) {
    return err(featured.error);
  }
  const featuredSet = new Set(featured.value);
  const used = await runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT content_text FROM statuses
         WHERE account_id = ? AND kind = 'LocalNote' AND visibility = 'public'
         ORDER BY id DESC LIMIT 200`,
      )
      .bind(accountId)
      .all<{ content_text: string }>();
    const counts = hashtagUses((results ?? []).map((row) => row.content_text));
    return [...counts.entries()]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([tag]) => tag);
  });
  if (used.isErr()) {
    return err(used.error);
  }
  return ok(used.value.filter((tag) => !featuredSet.has(tag)).slice(0, limit));
};
