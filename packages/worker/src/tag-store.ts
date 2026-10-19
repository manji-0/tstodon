import { InstanceLimits } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  countAccountTagUses as countAccountTagUsesSql,
  countFeaturedTags as countFeaturedTagsSql,
  featureTag as featureTagSql,
  followTag as followTagSql,
  isTagFeatured as isTagFeaturedSql,
  isTagFollowed as isTagFollowedSql,
  listFeaturedTags as listFeaturedTagsSql,
  listFollowedTags as listFollowedTagsSql,
  unfeatureTag as unfeatureTagSql,
  unfollowTag as unfollowTagSql,
} from "./generated/prisma/sql";
import { extractHashtags } from "./status-store";
import { queryTyped, runTyped } from "./typed-sql";

export type TagHistoryEntry = Readonly<{ day: string; uses: string; accounts: string }>;

/** Mastodon's `FeaturedTag::LIMIT`, shared with the instance document. */
export const FEATURED_TAG_LIMIT = InstanceLimits.account.maxFeaturedTags;

const TAG_HISTORY_DAYS = 7;
const SECONDS_PER_DAY = 86_400;

/** Normalize a tag to its stored form: no leading `#`, lowercase. */
export const normalizeTag = (raw: string): string => raw.trim().replace(/^#+/, "").toLowerCase();

export const isValidTag = (tag: string): boolean => /^[a-z0-9_]+$/.test(tag);

export const followTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, followTagSql(accountId, tag, nowIso()));
  });

export const unfollowTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ tag_name: string }>(db, unfollowTagSql(accountId, tag));
    return rows.length > 0;
  });

export const isTagFollowed = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ tag_name: string }>(db, isTagFollowedSql(accountId, tag));
    return rows.length > 0;
  });

export const listFollowedTags = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ tag_name: string }>(db, listFollowedTagsSql(accountId));
    return rows.map((row) => row.tag_name);
  });

export const featureTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, featureTagSql(accountId, tag, nowIso()));
  });

export const unfeatureTag = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ tag_name: string }>(db, unfeatureTagSql(accountId, tag));
    return rows.length > 0;
  });

export const isTagFeatured = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ tag_name: string }>(db, isTagFeaturedSql(accountId, tag));
    return rows.length > 0;
  });

export const listFeaturedTags = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ tag_name: string }>(db, listFeaturedTagsSql(accountId));
    return rows.map((row) => row.tag_name);
  });

export const countFeaturedTags = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(db, countFeaturedTagsSql(accountId));
    return Number(rows[0]?.count ?? 0);
  });

/** Public status count and last use of a tag by one account. */
export const accountTagUses = async (
  db: D1Database,
  accountId: string,
  tag: string,
): Promise<Result<{ count: number; lastStatusAt: string | null }, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint; last_status_at: string | null }>(
      db,
      countAccountTagUsesSql(accountId, `%#${tag}%`),
    );
    const row = rows[0];
    return { count: Number(row?.count ?? 0), lastStatusAt: row?.last_status_at ?? null };
  });

/** One entry per UTC day for the last week, newest first, zero-filled. */
export const tagDailyHistory = async (
  db: D1Database,
  tag: string,
): Promise<Result<TagHistoryEntry[], RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - TAG_HISTORY_DAYS * SECONDS_PER_DAY * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT content_text, created_at, account_id FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' AND created_at >= ?
         ORDER BY id DESC LIMIT 1000`,
      )
      .bind(since)
      .all<{ content_text: string; created_at: string; account_id: string }>();
    const uses = new Map<string, number>();
    const accounts = new Map<string, Set<string>>();
    for (const row of results ?? []) {
      if (!extractHashtags(row.content_text).includes(tag)) {
        continue;
      }
      const day = Math.floor(Date.parse(row.created_at) / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
      if (!Number.isFinite(day)) {
        continue;
      }
      const key = String(day);
      uses.set(key, (uses.get(key) ?? 0) + 1);
      const seen = accounts.get(key) ?? new Set<string>();
      seen.add(row.account_id);
      accounts.set(key, seen);
    }
    const today = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    const entries: TagHistoryEntry[] = [];
    for (let offset = 0; offset < TAG_HISTORY_DAYS; offset += 1) {
      const key = String(today - offset * SECONDS_PER_DAY);
      entries.push({
        day: key,
        uses: String(uses.get(key) ?? 0),
        accounts: String(accounts.get(key)?.size ?? 0),
      });
    }
    return entries;
  });

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
    const counts = new Map<string, number>();
    for (const row of results ?? []) {
      for (const tag of extractHashtags(row.content_text)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([tag]) => tag);
  });
  if (used.isErr()) {
    return err(used.error);
  }
  return ok(used.value.filter((tag) => !featuredSet.has(tag)).slice(0, limit));
};
