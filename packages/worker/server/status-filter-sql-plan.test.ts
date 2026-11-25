import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { StatusId, StatusSearchQuery, StatusTarget } from "@tstodon/domain";
import { listQuotePage } from "./quote-store";
import { parseInstanceIdentity } from "./runtime-config";
import { searchStatusIds } from "./status-search-store";

const PlanRow = z.object({ detail: z.string() });

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The plan of the first statement `run` sends that reads `table`, with its
 * binds, its SQL passed through `rewrite` first.
 */
const planOf = async (
  table: string,
  run: () => Promise<unknown>,
  rewrite: (sql: string) => string = (sql) => sql,
): Promise<string[]> => {
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
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${rewrite(first.sql)}`)
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
    const details = await planOf("status_search", () =>
      searchStatusIds(
        env.DB,
        parseInstanceIdentity(env)._unsafeUnwrap(),
        "viewer",
        StatusSearchQuery.parse("words")._unsafeUnwrap(),
        20,
        0,
      ),
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

  // The index's rowid is the status id: a page reads the matches newest
  // first and stops at its limit, sorting nothing, and seeks each match's
  // document and note by key.
  it("reads the status search index newest first, without sorting the matches", async () => {
    const run = () =>
      searchStatusIds(
        env.DB,
        parseInstanceIdentity(env)._unsafeUnwrap(),
        "viewer",
        StatusSearchQuery.parse("words has:media from:me")._unsafeUnwrap(),
        20,
        0,
      );
    const details = await planOf("status_search", run);
    expect(details.slice(0, 3)).toEqual([
      expect.stringMatching(/^SCAN status_search VIRTUAL TABLE INDEX \d+:M/),
      "SEARCH d USING INTEGER PRIMARY KEY (rowid=?)",
      expect.stringMatching(/^SEARCH statuses USING INDEX \S+ \(id=\?\)( LEFT-JOIN)?$/),
    ]);
    expect(details).toContainEqual(
      expect.stringMatching(/^SEARCH r USING INDEX \S+ \(id=\?\)( LEFT-JOIN)?$/),
    );
    // The checks of the author's flag and the viewer's library seek by key;
    // `remote_actor_domain_rules` is the instance rules' view, read once.
    expect(
      details.filter(
        (detail) =>
          detail.startsWith("SCAN ") && !/VIRTUAL TABLE|remote_actor_domain_rules/.test(detail),
      ),
    ).toEqual([]);
    const unordered = await planOf("status_search", run, (sql) =>
      sql.replace("ORDER BY status_search.rowid DESC", ""),
    );
    const sorts = (plan: string[]) =>
      plan.filter((detail) => detail === "USE TEMP B-TREE FOR ORDER BY").length;
    expect(sorts(details)).toBe(sorts(unordered));
  });

  // What a trigger runs to write one note's row again, as in migration 0015.
  it("builds a note's search row from its own rows, by key", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id, text, tags, scope FROM status_search_rows
       WHERE id IN (SELECT id FROM status_search_documents WHERE status_id = ? OR remote_status_id = ?)`,
    )
      .bind("1", "2")
      .all();
    const details = z
      .array(PlanRow)
      .parse(results)
      .map((row) => row.detail);
    expect(details).toContainEqual("SEARCH d USING INTEGER PRIMARY KEY (rowid=?)");
    expect(
      details.filter((detail) => detail.startsWith("SCAN ") && !detail.includes("VIRTUAL TABLE")),
    ).toEqual([]);
  });

  // The page sorts the one status's quotes, as Mastodon's does, but reads only those.
  it("seeks the quotes of one status and each quoting status by key", async () => {
    const details = await planOf("status_quotes", () =>
      listQuotePage(env.DB, StatusTarget.local(StatusId.schema.parse("1")), "viewer", 20, {
        maxId: "9",
        sinceId: "0",
      }),
    );
    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH q USING INDEX idx_status_quotes_quoted \(quoted_status_id=\? AND state=\?\)/,
      ),
    );
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH s USING .*\(id=\?\)/));
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH r USING .*\(id=\?\)/));
    expect(details.filter((detail) => detail.startsWith("SCAN "))).toEqual([]);
  });
});
