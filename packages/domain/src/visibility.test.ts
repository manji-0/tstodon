import { describe, expect, it } from "vitest";
import { Visibility } from "./visibility";

describe("Visibility", () => {
  it("round-trips Mastodon private to FollowersOnly", () => {
    const parsed = Visibility.fromMastodon("private");
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("FollowersOnly");
      expect(Visibility.toMastodon(parsed.value)).toBe("private");
      expect(Visibility.isRestricted(parsed.value)).toBe(true);
    }
  });

  it("rejects unknown mastodon values", () => {
    const parsed = Visibility.fromMastodon("friends");
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.kind).toBe("Unknown");
    }
  });
});
