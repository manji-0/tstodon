import { ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { Visibility, reblogVisibility } from "./visibility";

describe("Visibility", () => {
  it("round-trips Mastodon private to FollowersOnly", () => {
    const parsed = Visibility.fromParam("private");
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("FollowersOnly");
      expect(Visibility.toRest(parsed.value)).toBe("private");
      expect(Visibility.isRestricted(parsed.value)).toBe(true);
    }
  });

  it("takes limited as a param and keeps it, as Mastodon's visibility enum", () => {
    expect(Visibility.fromParam("limited").map((found) => found.kind)).toEqual(ok("Limited"));
    expect(Visibility.toParam(Visibility.Limited)).toBe("limited");
    expect(Visibility.fromParam("direct").map((found) => found.kind)).toEqual(ok("Direct"));
  });

  it("does not take limited as an account's default, as UserSettings#default_privacy", () => {
    expect(Visibility.selectableFromParam("limited").isErr()).toBe(true);
    expect(Visibility.selectableFromParam("private").map((found) => found.kind)).toEqual(
      ok("FollowersOnly"),
    );
  });

  it("renders Limited as private, as REST::StatusSerializer#visibility", () => {
    expect(Visibility.toRest(Visibility.Limited)).toBe("private");
    expect(Visibility.toRest(Visibility.Direct)).toBe("direct");
  });

  it("asks for a mention on Direct and Limited only, as StatusPolicy#requires_mention?", () => {
    expect(Visibility.requiresMention(Visibility.Limited)).toBe(true);
    expect(Visibility.requiresMention(Visibility.Direct)).toBe(true);
    expect(Visibility.requiresMention(Visibility.FollowersOnly)).toBe(false);
    expect(Visibility.isRestricted(Visibility.Limited)).toBe(true);
    expect(Visibility.distributable(Visibility.Limited)).toBe(false);
  });

  it("makes a direct note with an audience-only account Limited, as Create#process_audience", () => {
    expect(Visibility.ofAudience(Visibility.Direct, { audienceOnly: true }).kind).toBe("Limited");
    expect(Visibility.ofAudience(Visibility.Direct, { audienceOnly: false }).kind).toBe("Direct");
    expect(Visibility.ofAudience(Visibility.FollowersOnly, { audienceOnly: true }).kind).toBe(
      "FollowersOnly",
    );
  });

  it("rejects unknown mastodon values", () => {
    const parsed = Visibility.fromParam("friends");
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
