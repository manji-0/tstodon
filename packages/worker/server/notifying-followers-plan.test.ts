import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import findNotifyingRemoteFollow from "../../../prisma/sql/findNotifyingRemoteFollow.sql?raw";
import listNotifyingFollowers from "../../../prisma/sql/listNotifyingFollowers.sql?raw";
import listNotifyingFollowersAmong from "../../../prisma/sql/listNotifyingFollowersAmong.sql?raw";
import listNotifyingRemoteFollowers from "../../../prisma/sql/listNotifyingRemoteFollowers.sql?raw";

const PlanRow = z.object({ detail: z.string() });

/** The searches of `blocks` and `mutes` in the plan of the TypedSQL file `sql`. */
const blockAndMuteSearches = async (sql: string): Promise<string[]> => {
  const params = new Set(sql.match(/\$\d+/g) ?? []);
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\$(\d+)/g, "?$1")}`)
    .bind(...Array.from({ length: params.size }, (_, n) => (n === params.size - 1 ? 50 : "x")))
    .all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail)
    .filter((detail) => /^SEARCH (b|m) /.test(detail));
};

// D1 keeps no `sqlite_stat1`, so SQLite would seek a block or mute of a
// mentioned account by its target and read every account that blocks or
// mutes it, once per follower. Each must be sought by the follower instead,
// whose own blocks and mutes are few.
describe("the notifying-follower queries' plans", () => {
  it.each([
    ["listNotifyingFollowers", listNotifyingFollowers],
    ["listNotifyingFollowersAmong", listNotifyingFollowersAmong],
    ["listNotifyingRemoteFollowers", listNotifyingRemoteFollowers],
    ["findNotifyingRemoteFollow", findNotifyingRemoteFollow],
  ])("%s seeks blocks and mutes by the follower", async (_name, sql) => {
    const searches = await blockAndMuteSearches(sql);
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(search).toMatch(/\((blocker_account_id|account_id)=\?/);
    }
  });
});

// A local note's notifying followers are read a page at a time after a
// follow id, so each page must seek the author's follows from that id in id
// order, not read and sort all of them.
describe("the local notifying-follower page's plan", () => {
  it("seeks the author's follows from the page's follow id, in id order", async () => {
    const params = new Set(listNotifyingFollowers.match(/\$\d+/g) ?? []);
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${listNotifyingFollowers.replace(/\$(\d+)/g, "?$1")}`,
    )
      .bind(...Array.from({ length: params.size }, (_, n) => (n === params.size - 1 ? 50 : "x")))
      .all();
    const plan = z
      .array(PlanRow)
      .parse(results)
      .map((row) => row.detail);
    expect(plan).toContain(
      "SEARCH f USING INDEX idx_follows_target_id (target_account_id=? AND id>?)",
    );
    expect(plan.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([]);
  });
});

// A direct note's addressed followers are a handful of accounts; their
// follows must be sought by each one, not by scanning the author's.
describe("the addressed notifying-follower query's plan", () => {
  it("seeks each addressed account's follow, reading no other follower", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${listNotifyingFollowersAmong.replace(/\$(\d+)/g, "?$1")}`,
    )
      .bind("x", "x", "x", "x", "[]")
      .all();
    const follows = z
      .array(PlanRow)
      .parse(results)
      .map((row) => row.detail)
      .filter((detail) => / f( |$)/.test(detail));
    expect(follows).toHaveLength(1);
    expect(follows[0]).toMatch(/^SEARCH f USING INDEX \w+ \(follower_account_id=\? AND /);
  });
});
