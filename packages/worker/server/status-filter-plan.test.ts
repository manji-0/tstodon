import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const PlanRow = z.object({ detail: z.string() });

const plan = async (): Promise<string[]> => {
  const typed = listUnfollowedSilencedAuthorsJson(
    "viewer",
    JSON.stringify(["account"]),
    JSON.stringify(["https://remote.example/users/actor"]),
  );
  const { results } = await d1PrepareTyped(env.DB, {
    sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
    values: typed.values,
  }).all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail);
};

describe("the silenced authors statement", () => {
  // The rows scanned are the listed ids and, per actor, its two hosts and their parent domains.
  it("seeks each listed author instead of scanning a table", async () => {
    const scans = (await plan()).filter(
      (detail) =>
        detail.startsWith("SCAN ") &&
        !/^SCAN (json_each|CONSTANT ROW|hosts|variants)\b/.test(detail),
    );
    expect(scans).toEqual([]);
  });

  // One seek per domain above each actor host, not a read of every block per actor.
  it("seeks a domain block by its domain", async () => {
    const searches = (await plan()).filter((detail) => detail.startsWith("SEARCH d "));
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(search).toMatch(/\bdomain=\?/);
    }
  });
});
