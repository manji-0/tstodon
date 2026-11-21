import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { insertLocalNote, insertRemoteStatus } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const PlanRow = z.object({ detail: z.string() });

const plan = async (typed: { sql: string; values: unknown[] }): Promise<string[]> => {
  const { results } = await d1PrepareTyped(env.DB, {
    sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
    values: typed.values,
  }).all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail);
};

describe("whom a reply answers, set when it is stored", () => {
  it("seeks a local note's parent by key", async () => {
    const details = await plan(
      insertLocalNote("1", "a", "2", "t", "<p>t</p>", "public", 0, "", null, "x", "x"),
    );
    expect(details.filter((detail) => /^SCAN /.test(detail))).toEqual([]);
    expect(
      details.some((detail) =>
        /^SEARCH p USING INTEGER PRIMARY KEY|^SEARCH p USING .*INDEX/.test(detail),
      ),
    ).toBe(true);
  });

  it("seeks a remote note's parent by key", async () => {
    const details = await plan(
      insertRemoteStatus(
        "1",
        "https://r.example/users/a",
        "https://r.example/notes/1",
        null,
        "",
        "",
        "public",
        0,
        null,
        "x",
        "[]",
        "x",
        "x",
        "https://r.example/notes/0",
        null,
        null,
        "[]",
        null,
        null,
      ),
    );
    expect(details.filter((detail) => /^SCAN /.test(detail))).toEqual([]);
    expect(details.filter((detail) => /^SEARCH (p|l) /.test(detail)).length).toBeGreaterThan(0);
  });

  it("finds the replies a late parent links by their reply URI", async () => {
    // The body of migration 0162's `remote_statuses_link_replies` trigger.
    const details = await plan({
      sql: `UPDATE remote_statuses SET in_reply_to_actor_uri = $1
            WHERE in_reply_to_uri = $2
              AND in_reply_to_account_id IS NULL
              AND in_reply_to_actor_uri IS NULL`,
      values: ["https://r.example/users/a", "https://r.example/notes/1"],
    });
    expect(details).toEqual([
      expect.stringMatching(
        /^SEARCH remote_statuses USING INDEX idx_remote_statuses_in_reply_to_uri/,
      ),
    ]);
  });
});
