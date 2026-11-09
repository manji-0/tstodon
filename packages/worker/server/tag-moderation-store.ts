import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { jsonStringArray, parseRows, runD1, type RepositoryError } from "./d1";
import {
  findTagModeration as findTagModerationSql,
  listRestrictedTagNames as listRestrictedTagNamesSql,
  listTagModerationsByNamesJson,
  updateTagModeration as updateTagModerationSql,
} from "./generated/prisma/sql";
import { rejectedTrendTargets } from "./trend-review-store";
import { queryTyped, runTyped } from "./typed-sql";

/**
 * What an admin decided about a stored hashtag (migration 0123), as
 * Mastodon's `Tag#usable`, `#listable` and `#display_name`:
 *
 * - an unusable tag's timeline lists nothing, accounts cannot feature it,
 *   and it leaves search and trends;
 * - an unlisted tag leaves search and trends;
 * - `trendable` is the trend review (`trend_reviews`): rejecting a tag keeps
 *   it out of trends.
 */
export type TagModeration = Readonly<{
  name: string;
  usable: boolean;
  listable: boolean;
  displayName: string | undefined;
}>;

const TagModerationRow = z.object({
  name: z.string(),
  usable: z.number(),
  listable: z.number(),
  display_name: z.string().nullable(),
});

const fromRow = (row: z.infer<typeof TagModerationRow>): TagModeration => ({
  name: row.name,
  usable: row.usable !== 0,
  listable: row.listable !== 0,
  displayName: row.display_name ?? undefined,
});

/** The defaults of a tag no admin has touched (or one not stored yet). */
export const defaultTagModeration = (name: string): TagModeration => ({
  name,
  usable: true,
  listable: true,
  displayName: undefined,
});

/** The stored tag's moderation; `undefined` when the tag is not stored. */
export const findTagModeration = async (
  db: D1Database,
  name: string,
): Promise<Result<TagModeration | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = (await queryTyped(db, findTagModerationSql(name), TagModerationRow))[0];
    return row ? fromRow(row) : undefined;
  });

/** Each named tag's moderation; a tag not stored has the defaults. */
export const tagModerations = async (
  db: D1Database,
  names: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, TagModeration>, RepositoryError>> =>
  runD1(async () => {
    if (names.length === 0) {
      return new Map<string, TagModeration>();
    }
    const rows = await queryTyped(
      db,
      listTagModerationsByNamesJson(jsonStringArray(names)),
      TagModerationRow,
    );
    const stored = new Map(rows.map((row) => [row.name, fromRow(row)]));
    return new Map(names.map((name) => [name, stored.get(name) ?? defaultTagModeration(name)]));
  });

/** Whether posts may use the tag (`true` for a tag not stored). */
export const isTagUsable = async (
  db: D1Database,
  name: string,
): Promise<Result<boolean, RepositoryError>> =>
  (await findTagModeration(db, name)).map((found) => found?.usable ?? true);

/**
 * The tags the public trends leave out: rejected in review, unusable, or
 * unlisted.
 */
export const untrendableTags = async (
  db: D1Database,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const [rejected, restricted] = await Promise.all([
    rejectedTrendTargets(db, "Tag"),
    runD1(async () =>
      (await queryTyped(db, listRestrictedTagNamesSql(), z.object({ name: z.string() }))).map(
        (row) => row.name,
      ),
    ),
  ]);
  if (rejected.isErr()) {
    return err(rejected.error);
  }
  if (restricted.isErr()) {
    return err(restricted.error);
  }
  return ok(new Set([...rejected.value, ...restricted.value]));
};

export const saveTagModeration = async (
  db: D1Database,
  moderation: TagModeration,
): Promise<Result<void, RepositoryError>> =>
  (
    await runD1(() =>
      runTyped(
        db,
        updateTagModerationSql(
          moderation.name,
          moderation.usable ? 1 : 0,
          moderation.listable ? 1 : 0,
          moderation.displayName ?? "",
        ),
      ),
    )
  ).map(() => undefined);

const TagPageRow = TagModerationRow.extend({ created_at: z.string() });

/**
 * A page of stored tags for the admin list, by name: tstodon names a tag by
 * its name, so Mastodon's `max_id` / `since_id` / `min_id` are names here
 * and the list runs from the last name to the first, as Mastodon's runs from
 * the newest id.
 */
export const listTagModerationPage = async (
  db: D1Database,
  cursor: Readonly<{
    maxId?: string | undefined;
    sinceId?: string | undefined;
    minId?: string | undefined;
  }>,
  limit: number,
): Promise<Result<TagModeration[], RepositoryError>> =>
  runD1(async () => {
    const after = cursor.minId || cursor.sinceId || "";
    const ascending = Boolean(cursor.minId);
    const where = after ? "WHERE name > ?" : cursor.maxId ? "WHERE name < ?" : "";
    const binds = after ? [after] : cursor.maxId ? [cursor.maxId] : [];
    const { results } = await db
      .prepare(
        `SELECT name, usable, listable, display_name, created_at FROM tags ${where}
         ORDER BY name ${ascending ? "ASC" : "DESC"} LIMIT ?`,
      )
      .bind(...binds, limit)
      .all();
    const rows = parseRows(TagPageRow, results).map(fromRow);
    return ascending ? rows.toReversed() : rows;
  });
