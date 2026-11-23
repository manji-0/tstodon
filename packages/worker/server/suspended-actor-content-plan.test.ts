import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { purgeReadSqls } from "./suspended-actor-content";

const PlanRow = z.object({ detail: z.string() });

const plan = async (sql: string): Promise<string[]> => {
  const params = new Set(sql.match(/\?\d+/g) ?? []);
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...Array.from({ length: params.size }, () => 1))
    .all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail);
};

// D1 keeps no `sqlite_stat1`, so SQLite may read a whole content table and
// seek each row's purge. Each page must walk the few purges and seek their
// actors' rows by an index.
describe("a suspended actor content purge page's plan", () => {
  it.each(
    purgeReadSqls.map((sql) => [
      (sql.match(/CROSS JOIN (\w+)/) ?? sql.match(/FROM (\w+)/))?.[1],
      sql,
    ]),
  )("seeks the content by actor: %s", async (_name, sql) => {
    const details = await plan(sql);
    const content = details.filter((detail) => /^(SCAN|SEARCH) (t|statuses)\b/.test(detail));
    expect(content.length).toBeGreaterThan(0);
    for (const detail of content) {
      expect(detail).toMatch(/^SEARCH (t|statuses) USING (COVERING )?INDEX /);
    }
  });
});
