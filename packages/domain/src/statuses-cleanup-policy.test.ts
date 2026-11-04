import { describe, expect, it } from "vite-plus/test";
import { type StatusCleanupFacts, StatusesCleanupPolicy } from "./statuses-cleanup-policy";
import { Visibility } from "./visibility";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const enabled = (
  rules: Partial<StatusesCleanupPolicy["rules"]> = {},
  kind: "Enabled" | "Disabled" = "Enabled",
): StatusesCleanupPolicy => ({
  kind,
  rules: {
    ...StatusesCleanupPolicy.default.rules,
    keepPinned: false,
    keepDirect: false,
    keepSelfFavourited: false,
    keepSelfBookmarked: false,
    ...rules,
  },
});

const old = (facts: Partial<StatusCleanupFacts> = {}): StatusCleanupFacts => ({
  createdAtMs: NOW - 30 * DAY_MS,
  visibility: Visibility.Public,
  pinned: false,
  favouritedBySelf: false,
  bookmarkedBySelf: false,
  hasPoll: false,
  hasMedia: false,
  favouritesCount: 0,
  boostsCount: 0,
  ...facts,
});

describe("StatusesCleanupPolicy.shouldDelete", () => {
  it("deletes an old post that no rule protects", () => {
    expect(StatusesCleanupPolicy.shouldDelete(enabled(), old(), NOW)).toBe(true);
  });

  it("deletes nothing while the policy is disabled", () => {
    expect(StatusesCleanupPolicy.shouldDelete(enabled({}, "Disabled"), old(), NOW)).toBe(false);
    expect(StatusesCleanupPolicy.shouldDelete(StatusesCleanupPolicy.default, old(), NOW)).toBe(
      false,
    );
  });

  it("keeps a post that is younger than the minimum age, and deletes it at the threshold", () => {
    const policy = enabled({ minAgeSeconds: 14 * 24 * 60 * 60 });
    expect(
      StatusesCleanupPolicy.shouldDelete(policy, old({ createdAtMs: NOW - 13 * DAY_MS }), NOW),
    ).toBe(false);
    expect(
      StatusesCleanupPolicy.shouldDelete(policy, old({ createdAtMs: NOW - 14 * DAY_MS }), NOW),
    ).toBe(true);
    expect(
      StatusesCleanupPolicy.shouldDelete(policy, old({ createdAtMs: NOW - 15 * DAY_MS }), NOW),
    ).toBe(true);
  });

  it.each([
    ["keepPinned", "pinned", { pinned: true }],
    ["keepDirect", "direct", { visibility: Visibility.Direct }],
    ["keepSelfFavourited", "self-favourited", { favouritedBySelf: true }],
    ["keepSelfBookmarked", "self-bookmarked", { bookmarkedBySelf: true }],
    ["keepPolls", "poll", { hasPoll: true }],
    ["keepMedia", "media", { hasMedia: true }],
  ] as const)("%s protects a %s post only while on", (rule, _label, facts) => {
    expect(StatusesCleanupPolicy.shouldDelete(enabled({ [rule]: true }), old(facts), NOW)).toBe(
      false,
    );
    expect(StatusesCleanupPolicy.shouldDelete(enabled({ [rule]: false }), old(facts), NOW)).toBe(
      true,
    );
  });

  it("keeps a post with at least the favourite threshold, and only then", () => {
    const policy = enabled({ keepFavourites: { kind: "AtLeast", count: 3 } });
    expect(StatusesCleanupPolicy.shouldDelete(policy, old({ favouritesCount: 2 }), NOW)).toBe(true);
    expect(StatusesCleanupPolicy.shouldDelete(policy, old({ favouritesCount: 3 }), NOW)).toBe(
      false,
    );
    expect(StatusesCleanupPolicy.shouldDelete(enabled(), old({ favouritesCount: 99 }), NOW)).toBe(
      true,
    );
  });

  it("keeps a post with at least the boost threshold, and only then", () => {
    const policy = enabled({ keepBoosts: { kind: "AtLeast", count: 2 } });
    expect(StatusesCleanupPolicy.shouldDelete(policy, old({ boostsCount: 1 }), NOW)).toBe(true);
    expect(StatusesCleanupPolicy.shouldDelete(policy, old({ boostsCount: 2 }), NOW)).toBe(false);
    expect(StatusesCleanupPolicy.shouldDelete(enabled(), old({ boostsCount: 99 }), NOW)).toBe(true);
  });

  it("rejects a minimum age Mastodon does not offer", () => {
    const parsed = StatusesCleanupPolicy.parse({
      kind: "Enabled",
      rules: { ...enabled().rules, minAgeSeconds: 12345 },
    });
    expect(parsed.isErr()).toBe(true);
  });
});
