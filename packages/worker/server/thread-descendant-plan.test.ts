import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { listThreadDescendantIds } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const PlanRow = z.object({ detail: z.string() });

describe("thread descendant tree statement", () => {
  it.each(["Local", "Remote"])("seeks statuses for a %s root instead of scanning", async (kind) => {
    const typed = listThreadDescendantIds(kind, "root", "https://example.com/users/", 40, 2000);
    const { results } = await d1PrepareTyped(env.DB, {
      sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
      values: typed.values,
    }).all();
    const scans = z
      .array(PlanRow)
      .parse(results)
      .map((row) => row.detail)
      .filter((detail) => /^SCAN (s|rs|a)\b/.test(detail));
    expect(scans).toEqual([]);
  });
});
