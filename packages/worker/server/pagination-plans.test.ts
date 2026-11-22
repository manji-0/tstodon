import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  countUnreadNotifications,
  listListMembers,
  pageAccountDomainBlocks,
  pageFollowedTags,
} from "./generated/prisma/sql";
import { pageEngagedTargetsSql } from "./status-interaction-store";
import { d1PrepareTyped, type TypedSqlLike } from "./typed-sql";

const plan = async (typed: TypedSqlLike): Promise<string[]> => {
  const { results } = await d1PrepareTyped(env.DB, {
    sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
    values: typed.values,
  }).all();
  return z
    .array(z.object({ detail: z.string() }))
    .parse(results)
    .map((row) => row.detail);
};

/** The pages REST-17 added seek their rows by index, in the page's order. */
describe("paged list statements", () => {
  it("walks an account's domain blocks by (account_id, id)", async () => {
    const details = await plan(pageAccountDomainBlocks("a", "", "", 100));

    expect(details).toContainEqual(
      expect.stringMatching(
        /SEARCH account_domain_blocks USING INDEX idx_account_domain_blocks_account_id/,
      ),
    );
    expect(details.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([]);
  });

  it("walks an account's followed tags by (account_id, id)", async () => {
    const details = await plan(pageFollowedTags("a", "", "", 100));

    expect(details).toContainEqual(
      expect.stringMatching(/SEARCH followed_tags USING INDEX idx_followed_tags_account_id/),
    );
    expect(details.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([]);
  });

  it("seeks a list's local and remote members by primary key", async () => {
    const details = await plan(listListMembers("l", "", "", 40));

    expect(details.filter((detail) => /^SCAN /.test(detail))).toEqual([]);
    expect(details).toContainEqual(
      expect.stringMatching(
        /SEARCH account_list_members USING (COVERING )?INDEX sqlite_autoindex_account_list_members_1/,
      ),
    );
    expect(details).toContainEqual(
      expect.stringMatching(
        /SEARCH m USING (COVERING )?INDEX sqlite_autoindex_account_list_remote_members_1/,
      ),
    );
  });

  it.each(["favourites", "bookmarks"] as const)(
    "walks an account's %s by (account_id, id)",
    async (table) => {
      const page = pageEngagedTargetsSql(table, "a", 20, { sinceId: "1", maxId: "9" });
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${page.sql}`)
        .bind(...page.binds)
        .all();
      const details = z
        .array(z.object({ detail: z.string() }))
        .parse(results)
        .map((row) => row.detail);

      expect(details).toEqual([
        `SEARCH ${table} USING INDEX idx_${table}_account_id (account_id=? AND id>? AND id<?)`,
      ]);
    },
  );

  it("counts unread notifications in (account_id, id) order", async () => {
    const details = await plan(countUnreadNotifications("a", "", "", 100));

    expect(details).toContainEqual(expect.stringMatching(/SEARCH n USING INDEX/));
    expect(details.filter((detail) => /^SCAN (n|notifications)\b/.test(detail))).toEqual([]);
  });
});
