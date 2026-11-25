import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { signedInAccount } from "../test/auth-fixture";
import { QUOTES_BY_QUOTING_SQL } from "./quote-store";

/**
 * Plans once `ANALYZE` (or `PRAGMA optimize`) has stored table statistics.
 * The statistics of an index on a mostly-NULL column count the NULLs as one
 * value, so the planner calls the index unselective and scans instead;
 * partial `IS NOT NULL` indexes keep the lookups below seeking
 * (`pnpm bench --analyze`, `docs/architecture/d1-heavy-scenarios.md#benchmark`).
 */

const plan = async (sql: string, binds: ReadonlyArray<string>): Promise<string[]> => {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all();
  return z
    .array(z.object({ detail: z.string() }))
    .parse(results)
    .map((row) => row.detail);
};

const series = (n: number) =>
  `WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < ${n})`;

/** `count` public local notes by a new account, ids `<prefix>000001` up. */
const seedNotes = async (prefix: string, count: number) => {
  const author = await signedInAccount(`${prefix}@example.com`);
  await env.DB.prepare(
    `${series(count)} INSERT INTO statuses (id, account_id, kind, content_text, visibility)
     SELECT printf('${prefix}%06d', n), ?, 'LocalNote', 'n', 'public' FROM s`,
  )
    .bind(author.id)
    .run();
};

afterEach(async () => {
  await env.DB.prepare("DELETE FROM sqlite_stat1").run();
  await env.DB.prepare("ANALYZE sqlite_schema").run();
});

describe("plans with table statistics", () => {
  it("seeks a page's quotes by the quoting columns", async () => {
    // 2,000 rows per lookup on the benchmark's 1,990 quotes before migration 0016.
    await seedNotes("quoteplan", 500);
    await env.DB.prepare(
      `${series(500)} INSERT INTO status_quotes (id, status_id, quoted_status_id, state, created_at, updated_at)
       SELECT printf('quoteplanq%06d', n), printf('quoteplan%06d', n), printf('quoteplan%06d', n - 1),
         'accepted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
       FROM s WHERE n > 1`,
    ).run();
    const binds = [JSON.stringify(["quoteplan000007"]), JSON.stringify(["remote-1"])];
    const seeks = (details: ReadonlyArray<string>) => {
      expect(details.filter((detail) => /SCAN status_quotes/.test(detail))).toEqual([]);
      expect(
        details.filter((detail) => /SEARCH status_quotes USING (COVERING )?INDEX/.test(detail)),
      ).toHaveLength(2);
    };
    seeks(await plan(QUOTES_BY_QUOTING_SQL, binds));
    await env.DB.prepare("ANALYZE").run();
    seeks(await plan(QUOTES_BY_QUOTING_SQL, binds));
  });

  it("counts a new remote status's local replies without scanning local statuses", async () => {
    // `remote_statuses_insert_replies_count` counts the local statuses that
    // answer the new remote status by URI: 180,034 rows read per stored remote
    // status on the benchmark's 200,000 local statuses before migration 0015.
    await seedNotes("replyplan", 2_000);
    await env.DB.prepare(
      `INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, fetched_at)
       VALUES ('https://plans.example/users/a', 'a', 'plans.example', 'https://plans.example/inbox', '2026-01-01T00:00:00.000Z')`,
    ).run();
    await env.DB.prepare("ANALYZE").run();
    const stored = await env.DB.prepare(
      `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
       VALUES ('replyplan-remote', 'https://plans.example/users/a', 'https://plans.example/statuses/1', '<p>r</p>', 'public', '2026-01-01T00:00:00.000Z')`,
    ).run();

    expect(stored.meta.rows_read).toBeLessThan(50);
  });
});
