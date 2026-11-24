import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  DELETE_EXPIRED_JSONLD_CONTEXTS_SQL,
  FIND_JSONLD_CONTEXT_SQL,
} from "./jsonld-remote-contexts";

const details = async (statement: D1PreparedStatement): Promise<string[]> =>
  z
    .array(z.object({ detail: z.string() }))
    .parse((await statement.all()).results)
    .map((row) => row.detail);

describe("the fetched JSON-LD context reads", () => {
  // A forward that names a context reads it by its URL, whatever else is kept.
  it("seeks a context by its URL", async () => {
    const plan = await details(
      env.DB.prepare(`EXPLAIN QUERY PLAN ${FIND_JSONLD_CONTEXT_SQL}`).bind("u", "t"),
    );
    expect(plan).toEqual([
      "SEARCH jsonld_contexts USING INDEX sqlite_autoindex_jsonld_contexts_1 (url=?)",
    ]);
  });

  // Storing a context forgets the expired ones by the index, not a scan.
  it("finds the expired contexts by when they were fetched", async () => {
    const plan = await details(
      env.DB.prepare(`EXPLAIN QUERY PLAN ${DELETE_EXPIRED_JSONLD_CONTEXTS_SQL}`).bind("t"),
    );
    expect(plan).toEqual([
      "SEARCH jsonld_contexts USING INDEX idx_jsonld_contexts_fetched_at (fetched_at<?)",
    ]);
  });
});
