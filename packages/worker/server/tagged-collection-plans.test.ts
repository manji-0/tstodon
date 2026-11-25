import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { TAGGED_COLLECTIONS_SQL } from "./tagged-collection-store";

const details = async (statement: D1PreparedStatement): Promise<string[]> =>
  z
    .array(z.object({ detail: z.string() }))
    .parse((await statement.all()).results)
    .map((row) => row.detail);

describe("the tagged collections read", () => {
  // A page of statuses reads its tags with one statement: a seek per status
  // in each table, whatever the tables hold.
  it("seeks each status's tags by its status id", async () => {
    const plan = await details(
      env.DB.prepare(`EXPLAIN QUERY PLAN ${TAGGED_COLLECTIONS_SQL}`).bind('["1"]', '["2"]'),
    );

    expect(plan).toContainEqual(
      expect.stringMatching(
        /^SEARCH status_tagged_collections USING INDEX sqlite_autoindex_status_tagged_collections_\d \(status_id=\?\)$/,
      ),
    );
    expect(plan).toContainEqual(
      expect.stringMatching(
        /^SEARCH remote_status_tagged_collections USING INDEX sqlite_autoindex_remote_status_tagged_collections_\d \(status_id=\?\)$/,
      ),
    );
    expect(
      plan.filter((detail) => /^SCAN (remote_)?status_tagged_collections\b/.test(detail)),
    ).toEqual([]);
  });
});
