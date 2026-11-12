import { isHashtagName, normalizeHashtag } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, runD1Batch, type RepositoryError } from "./d1";
import {
  advanceBackfillCursor as advanceBackfillCursorSql,
  readBackfillCursor as readBackfillCursorSql,
} from "./generated/prisma/sql";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

/** The `backfill_cursors` row migration 0135 seeds: the last stored name read. */
const CURSOR = "tag_name_fold";

/** Names read per page; a page is one batch of 15 statements, whatever its size. */
export const TAG_NAME_FOLD_PAGE = 200;

/**
 * A stored name with a character outside printable ASCII. `normalizeHashtag`
 * leaves an ASCII name that an older `normalizeHashtag` stored as it is, so
 * only these can change.
 */
const NON_ASCII = "*[^ -~]*";

const CursorRow = z.object({ after_id: z.string(), completed_at: z.string().nullable() });
const NameRow = z.object({ name: z.string() });

/** The next names of one table's column after the cursor that hold a non-ASCII character. */
const namesOf = (table: string, column: string, where = ""): string =>
  `SELECT name FROM (
     SELECT DISTINCT ${column} AS name FROM ${table}
     WHERE ${where}${column} > ?1 AND ${column} GLOB ?2 ORDER BY name LIMIT ?3)`;

/**
 * The next non-ASCII names after the cursor, across every table that holds
 * a tag name. D1 takes five terms in a compound select, so the tables are
 * read in two.
 */
const LIST_NAMES = `
SELECT name FROM (
  SELECT name FROM (
    ${namesOf("tags", "name")}
    UNION ${namesOf("followed_tags", "tag_name")}
    UNION ${namesOf("featured_tags", "tag_name")}
    UNION ${namesOf("trend_reviews", "target", "kind = 'Tag' AND ")})
  UNION SELECT name FROM (
    ${namesOf("local_status_tags", "tag")}
    UNION ${namesOf("remote_status_tags", "tag")}
    UNION ${namesOf("stream_subscriptions", "param", "stream IN ('hashtag', 'hashtag:local') AND ")})
) ORDER BY name LIMIT ?3`;

const OLD = "json_extract(e.value, '$[0]')";
const NEW = "json_extract(e.value, '$[1]')";
const OLD_NAMES = `(SELECT ${OLD} FROM json_each(?1) e)`;

/** Copy a membership table's rows to the new name (the union where it is taken), then drop the old. */
const renameMembership = (
  table: string,
  column: string,
  others: ReadonlyArray<string>,
  where = "",
): ReadonlyArray<string> => [
  `INSERT OR IGNORE INTO ${table} (${others.join(", ")}, ${column})
   SELECT ${others.map((other) => `r.${other}`).join(", ")}, ${NEW}
   FROM json_each(?1) e JOIN ${table} r ON r.${column} = ${OLD}${where}`,
  `DELETE FROM ${table} AS r WHERE r.${column} IN ${OLD_NAMES}${where}`,
];

/** As `renameMembership`, for an account's follow or feature: the earliest `created_at` wins. */
const renameDatedMembership = (table: string): ReadonlyArray<string> => [
  `INSERT INTO ${table} (account_id, created_at, tag_name)
   SELECT r.account_id, r.created_at, ${NEW}
   FROM json_each(?1) e JOIN ${table} r ON r.tag_name = ${OLD}
   WHERE true
   ON CONFLICT (account_id, tag_name) DO UPDATE SET
     created_at = min(created_at, excluded.created_at)`,
  `DELETE FROM ${table} AS r WHERE r.tag_name IN ${OLD_NAMES}`,
];

/**
 * The statements that rename `[[old, new], ...]` (bound as JSON) in every
 * table, by the merge rules of migration 0135. Each takes the pairs as its
 * one parameter, so a page of any size is these fourteen statements.
 */
const RENAMES: ReadonlyArray<string> = [
  // The more restrictive moderation wins; the folded row keeps its display name.
  `INSERT INTO tags (name, created_at, usable, listable, display_name)
   SELECT ${NEW}, o.created_at, o.usable, o.listable, o.display_name
   FROM json_each(?1) e JOIN tags o ON o.name = ${OLD}
   WHERE true
   ON CONFLICT (name) DO UPDATE SET
     created_at = min(created_at, excluded.created_at),
     usable = min(usable, excluded.usable),
     listable = min(listable, excluded.listable),
     display_name = coalesce(display_name, excluded.display_name)`,
  `DELETE FROM tags WHERE name IN ${OLD_NAMES}`,
  ...renameDatedMembership("followed_tags"),
  ...renameDatedMembership("featured_tags"),
  ...renameMembership("local_status_tags", "tag", ["status_id"]),
  ...renameMembership("remote_status_tags", "tag", ["status_id"]),
  ...renameMembership(
    "stream_subscriptions",
    "param",
    ["hub", "stream"],
    " AND r.stream IN ('hashtag', 'hashtag:local')",
  ),
  // A rejected tag stays out of the trends under its new name.
  `INSERT INTO trend_reviews (kind, target, state, reviewed_at)
   SELECT 'Tag', ${NEW}, o.state, o.reviewed_at
   FROM json_each(?1) e JOIN trend_reviews o ON o.kind = 'Tag' AND o.target = ${OLD}
   WHERE true
   ON CONFLICT (kind, target) DO UPDATE SET
     state = excluded.state, reviewed_at = excluded.reviewed_at
   WHERE excluded.state = 'Rejected' AND state <> 'Rejected'`,
  `DELETE FROM trend_reviews WHERE kind = 'Tag' AND target IN ${OLD_NAMES}`,
];

/** One page of the fold: the names it read and renamed, and whether another page follows. */
export type TagNameFoldPage = Readonly<{ scanned: number; renamed: number; chained: boolean }>;

/**
 * Rename the next page of tag names stored before `normalizeHashtag` folded
 * accents (`café`) to the name it gives now (`cafe`), in every table that
 * holds one, merging with the rows already under that name (the rules are
 * in migration 0135), and move the cursor past them. A short page marks the
 * cursor complete, after which every run reads the cursor and stops. The
 * renames and the cursor are one batch, and a rename of a name no row holds
 * writes nothing, so a repeated or concurrent page leaves the same rows.
 */
export const foldTagNames = async (
  db: D1Database,
  pageSize: number = TAG_NAME_FOLD_PAGE,
): Promise<Result<TagNameFoldPage, RepositoryError>> => {
  const read = await runD1(async () => {
    const cursor = (await queryTyped(db, readBackfillCursorSql(CURSOR), CursorRow))[0];
    if (cursor === undefined || cursor.completed_at !== null) {
      return undefined;
    }
    const { results } = await db
      .prepare(LIST_NAMES)
      .bind(cursor.after_id, NON_ASCII, pageSize)
      .all();
    return { afterId: cursor.after_id, names: parseRows(NameRow, results).map((row) => row.name) };
  });
  if (read.isErr()) {
    return err(read.error);
  }
  if (read.value === undefined) {
    return ok({ scanned: 0, renamed: 0, chained: false });
  }
  const { afterId, names } = read.value;
  const renames = names.flatMap((name): [string, string][] => {
    const folded = normalizeHashtag(name);
    // A name moves only to a tag name that stays where it is: a name that
    // would move again could be another pair's old name, whose rows the
    // page deletes. `normalizeHashtag` settles in one step but for a few
    // Greek and Arabic compatibility sequences.
    return folded !== name && isHashtagName(folded) && normalizeHashtag(folded) === folded
      ? [[name, folded]]
      : [];
  });
  const pairs = JSON.stringify(renames);
  const full = names.length === pageSize;
  const advanced = await runD1Batch(db, [
    ...(renames.length === 0 ? [] : RENAMES.map((sql) => db.prepare(sql).bind(pairs))),
    d1PrepareTyped(
      db,
      advanceBackfillCursorSql(CURSOR, afterId, names.at(-1) ?? afterId, full ? null : nowIso()),
    ),
  ]);
  if (advanced.isErr()) {
    return err(advanced.error);
  }
  const moved = (advanced.value.at(-1)?.results ?? []).length > 0;
  return ok({ scanned: names.length, renamed: renames.length, chained: moved && full });
};
