import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { mentionsBlockedOrMutedSql } from "./followed-feed";

const PlanRow = z.object({ detail: z.string() });

/** The mention table searches in the plan of a feed row filtered by the mention check. */
const mentionSearches = async (
  table: string,
  status: Parameters<typeof mentionsBlockedOrMutedSql>[2],
): Promise<string[]> => {
  const mentions = mentionsBlockedOrMutedSql("viewer", "2026-01-01T00:00:00.000Z", status);
  const { results } = await env.DB.prepare(
    `EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE NOT ${mentions.sql}`,
  )
    .bind(...mentions.binds)
    .all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail)
    .filter((detail) => detail.startsWith("SEARCH m "));
};

// A viewer with thousands of mutes must not cost a feed one mention seek per
// mute per row: each status's mentions are sought by its id, then checked
// against the viewer's blocks and mutes, gathered once.
describe("the feed mention check's plan", () => {
  it.each([
    ["statuses", { local: "statuses.id" }],
    ["remote_statuses", { remote: "remote_statuses.id" }],
  ] as const)("seeks %s mentions by status id only", async (table, status) => {
    const searches = await mentionSearches(table, status);
    expect(searches).toHaveLength(2);
    for (const search of searches) {
      expect(search).toMatch(/\(status_id=\?\)$/);
    }
  });
});
