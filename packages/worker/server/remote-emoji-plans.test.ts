import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { findRemoteCustomEmojis } from "./generated/prisma/sql";
import { REMOTE_EMOJI_DOMAIN_PAGE_SQL, REMOTE_EMOJI_PAGE_SQL } from "./remote-custom-emoji-store";
import { d1PrepareTyped } from "./typed-sql";

const details = async (statement: D1PreparedStatement): Promise<string[]> =>
  z
    .array(z.object({ detail: z.string() }))
    .parse((await statement.all()).results)
    .map((row) => row.detail);

const PRIMARY_KEY = "sqlite_autoindex_remote_custom_emojis_1";

describe("the remote custom emoji reads", () => {
  // A page renders its emoji with one statement: a primary-key seek for each
  // (domain, shortcode) its posts and profiles write, whatever the table holds.
  it("seeks each emoji a page writes by its primary key", async () => {
    const typed = findRemoteCustomEmojis(JSON.stringify([["a.example", "blob"]]));
    const plan = await details(
      d1PrepareTyped(env.DB, { sql: `EXPLAIN QUERY PLAN ${typed.sql}`, values: typed.values }),
    );

    expect(plan).toContainEqual(`SEARCH r USING INDEX ${PRIMARY_KEY} (domain=? AND shortcode=?)`);
    expect(plan.filter((detail) => /^SCAN r\b/.test(detail))).toEqual([]);
  });

  // The admin's list reads a page from where the last one ended, in the
  // primary key's order.
  it("walks the admin's list of remote emoji by its primary key", async () => {
    const all = await details(
      env.DB.prepare(`EXPLAIN QUERY PLAN ${REMOTE_EMOJI_PAGE_SQL}`).bind("a", "b", null, 26),
    );
    const ofDomain = await details(
      env.DB.prepare(`EXPLAIN QUERY PLAN ${REMOTE_EMOJI_DOMAIN_PAGE_SQL}`).bind("a", "", null, 26),
    );

    expect(all).toEqual([
      `SEARCH remote_custom_emojis USING INDEX ${PRIMARY_KEY} ((domain,shortcode)>(?,?))`,
    ]);
    expect(ofDomain).toEqual([
      `SEARCH remote_custom_emojis USING INDEX ${PRIMARY_KEY} (domain=? AND shortcode>?)`,
    ]);
  });
});
