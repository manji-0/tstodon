import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { searchStatuses } from "./status-timeline-store";

const PlanRow = z.object({ detail: z.string() });

afterEach(() => {
  vi.restoreAllMocks();
});

/** The plan of the first statement `run` sends that reads `table`, with its binds. */
const planOf = async (table: string, run: () => Promise<unknown>): Promise<string[]> => {
  const prepare = env.DB.prepare.bind(env.DB);
  const sent: { sql: string; binds: unknown[] }[] = [];
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...binds) => {
      sent.push({ sql, binds });
      return bind(...binds);
    };
    return statement;
  });
  await run();
  vi.restoreAllMocks();
  const first = sent.find(({ sql }) => new RegExp(`FROM ${table}\\b`).test(sql));
  if (first === undefined) {
    throw new Error(`no statement read ${table}`);
  }
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${first.sql}`)
    .bind(...first.binds)
    .all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail);
};

// Mastodon's `StatusFilter` runs in SQL before `LIMIT` / `OFFSET`; each row
// seeks its author's moderation and, for a silenced author, the follow.
describe("the status filter's plans", () => {
  it("seeks a search result's author moderation and follow by key", async () => {
    const details = await planOf("statuses", () =>
      searchStatuses(env.DB, "viewer", "words", 20, 0),
    );
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH m USING .*\(account_id=\?\)/));
    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH f USING .*\(follower_account_id=\? AND target_account_id=\?\)/,
      ),
    );
    expect(
      details.filter((detail) => /^SCAN (m|f|account_moderation|follows)\b/.test(detail)),
    ).toEqual([]);
  });
});
