import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const PlanRow = z.object({ detail: z.string() });

describe("the silenced authors statement", () => {
  it("seeks each listed author instead of scanning a table", async () => {
    const typed = listUnfollowedSilencedAuthorsJson(
      "viewer",
      JSON.stringify(["account"]),
      JSON.stringify(["https://remote.example/users/actor"]),
    );
    const { results } = await d1PrepareTyped(env.DB, {
      sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
      values: typed.values,
    }).all();
    const scans = z
      .array(PlanRow)
      .parse(results)
      .map((row) => row.detail)
      .filter((detail) => detail.startsWith("SCAN ") && !detail.startsWith("SCAN json_each"));
    expect(scans).toEqual([]);
  });
});
