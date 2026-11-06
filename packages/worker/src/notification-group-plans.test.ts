import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  dismissNotificationGroup,
  pageNotificationGroupsNewer,
  pageNotificationGroupsOlder,
  summarizeNotificationGroups,
} from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const PlanRow = z.object({ detail: z.string() });

/** The plan lines that read `notifications`, aliased `n` or `next` in these statements. */
const notificationReads = async (typed: {
  sql: string;
  values: ReadonlyArray<unknown>;
}): Promise<string[]> => {
  const { results } = await d1PrepareTyped(env.DB, {
    sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
    values: typed.values,
  }).all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail)
    .filter((detail) => /^(SCAN|SEARCH) (n|next)\b/.test(detail));
};

/**
 * A read that walks every notification of the account, or of every account:
 * `created_at` is bounded only by the clear marker.
 */
const wholeAccount = (detail: string): boolean =>
  detail.startsWith("SCAN") || /\(account_id=\?( AND created_at>\?)?\)$/.test(detail);

const page = [
  "account",
  "2026-11-06T00:00:00.000Z",
  40,
  "[]",
  "[]",
  "",
  0,
  '["favourite"]',
  "[]",
  "[]",
] as const;

describe("grouped notification statements", () => {
  it.each([
    ["the page read down", pageNotificationGroupsOlder(...page, "", "")],
    ["the page read up", pageNotificationGroupsNewer(...page, "", "1")],
    [
      "the group summaries",
      summarizeNotificationGroups(
        "account",
        "2026-11-06T00:00:00.000Z",
        JSON.stringify([{ key: "favourite-s", type: "favourite", target: "s" }]),
        "[]",
        "[]",
        "",
        0,
        "",
        0,
      ),
    ],
    [
      "the group dismissal",
      dismissNotificationGroup("account", "2026-11-06T00:00:00.000Z", "", "favourite", "s"),
    ],
  ])("reads %s through an index past the account", async (_name, typed) => {
    const reads = await notificationReads(typed);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter(wholeAccount)).toEqual([]);
  });
});
