import { describe, expect, it } from "vite-plus/test";
import { Visibility, reblogVisibility } from "./visibility";

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

  it("keeps a restricted original's visibility on a boost", () => {
    // A private original wins over the requested visibility.
    expect(
      reblogVisibility(Visibility.FollowersOnly, Visibility.Public, Visibility.Public).kind,
    ).toBe("FollowersOnly");
    expect(reblogVisibility(Visibility.Direct, undefined, Visibility.Public).kind).toBe("Direct");
  });

  it("uses the request, then the account default, for a distributable original", () => {
    expect(reblogVisibility(Visibility.Public, Visibility.Unlisted, Visibility.Public).kind).toBe(
      "Unlisted",
    );
    expect(reblogVisibility(Visibility.Public, undefined, Visibility.FollowersOnly).kind).toBe(
      "FollowersOnly",
    );
  });
});
