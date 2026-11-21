import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  dismissNotificationGroup,
  findNotificationGroupBucket,
  listNotifications,
  listNotificationsAscending,
  pageNotificationGroupsNewer,
  pageNotificationGroupsOlder,
  summarizeNotificationGroups,
} from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const PlanRow = z.object({ detail: z.string() });

/** The plan lines that read `notifications`, aliased `n`, `g` or `next` in these statements. */
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
    .filter((detail) => /^(SCAN|SEARCH) (n|g|next)\b/.test(detail));
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
        JSON.stringify([{ key: "favourite-s-493000" }, { key: "ungrouped-1", id: "1" }]),
        "[]",
        "",
        0,
        "",
        0,
      ),
    ],
    [
      "the group dismissal",
      dismissNotificationGroup("account", "2026-11-06T00:00:00.000Z", "", "favourite-s-493000"),
    ],
    ["the group bucket lookup", findNotificationGroupBucket("account", "favourite-s")],
  ])("reads %s through an index past the account", async (_name, typed) => {
    const reads = await notificationReads(typed);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter(wholeAccount)).toEqual([]);
  });

  it.each([
    [
      "the group members",
      summarizeNotificationGroups(
        "account",
        "2026-11-06T00:00:00.000Z",
        JSON.stringify([{ key: "follow-493000" }]),
        "[]",
        "",
        0,
        "",
        0,
      ),
    ],
    ["the latest bucket", findNotificationGroupBucket("account", "follow")],
    [
      "the group dismissal",
      dismissNotificationGroup("account", "2026-11-06T00:00:00.000Z", "", "follow-493000"),
    ],
  ])("seeks %s by stored group key", async (_name, typed) => {
    const reads = await notificationReads(typed);
    expect(reads.some((detail) => detail.includes("idx_notifications_account_group"))).toBe(true);
  });

  it.each([
    [
      "down",
      listNotifications(
        "account",
        "2026-11-06T00:00:00.000Z",
        40,
        "[]",
        "[]",
        "",
        "",
        "",
        0,
        "follow-493000",
      ),
    ],
    [
      "up",
      listNotificationsAscending(
        "account",
        "2026-11-06T00:00:00.000Z",
        40,
        "[]",
        "[]",
        "",
        "1",
        0,
        "follow-493000",
      ),
    ],
  ])("walks the account in id order for a group's senders read %s", async (_name, typed) => {
    const reads = await notificationReads(typed);
    expect(reads).toEqual([expect.stringMatching(/USING INDEX idx_notifications_account_id /)]);
  });
});
