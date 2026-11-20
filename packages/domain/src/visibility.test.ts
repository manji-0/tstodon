import { ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { RemoteVisibility, Visibility, reblogVisibility } from "./visibility";

describe("RemoteVisibility", () => {
  it("stores Limited as limited and reads it back", () => {
    expect(RemoteVisibility.toStored(RemoteVisibility.Limited)).toBe("limited");
    expect(RemoteVisibility.fromStored("limited").map((found) => found.kind)).toEqual(
      ok("Limited"),
    );
    expect(RemoteVisibility.fromStored("direct").map((found) => found.kind)).toEqual(ok("Direct"));
    expect(RemoteVisibility.fromStored("friends").isErr()).toBe(true);
  });

  it("renders Limited as private, as REST::StatusSerializer#visibility", () => {
    expect(RemoteVisibility.toMastodon(RemoteVisibility.Limited)).toBe("private");
    expect(RemoteVisibility.toMastodon(Visibility.Direct)).toBe("direct");
  });

  it("asks for a mention on Direct and Limited only, as StatusPolicy#requires_mention?", () => {
    expect(RemoteVisibility.requiresMention(RemoteVisibility.Limited)).toBe(true);
    expect(RemoteVisibility.requiresMention(Visibility.Direct)).toBe(true);
    expect(RemoteVisibility.requiresMention(Visibility.FollowersOnly)).toBe(false);
    expect(RemoteVisibility.isRestricted(RemoteVisibility.Limited)).toBe(true);
  });

  it("makes a direct note with an audience-only account Limited, as Create#process_audience", () => {
    expect(RemoteVisibility.ofAudience(Visibility.Direct, { audienceOnly: true }).kind).toBe(
      "Limited",
    );
    expect(RemoteVisibility.ofAudience(Visibility.Direct, { audienceOnly: false }).kind).toBe(
      "Direct",
    );
    expect(RemoteVisibility.ofAudience(Visibility.FollowersOnly, { audienceOnly: true }).kind).toBe(
      "FollowersOnly",
    );
  });
});

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
