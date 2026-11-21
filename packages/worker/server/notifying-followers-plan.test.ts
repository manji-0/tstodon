import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import findNotifyingRemoteFollow from "../../../prisma/sql/findNotifyingRemoteFollow.sql?raw";
import listNotifyingFollowers from "../../../prisma/sql/listNotifyingFollowers.sql?raw";
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
