import { describe, expect, it } from "vite-plus/test";
import { IsoInstant } from "./iso-instant";
import { ProfileField } from "./profile-field";

const at = IsoInstant.parse("2026-11-01T00:00:00.000Z")._unsafeUnwrap();

describe("ProfileField.requiresVerification", () => {
  const field = { name: "site", value: "" };

  it.each([
    "https://example.com",
    "https://example.com/",
    "https://example.com:8443/me",
    "https://example.com/@alice?tab=posts",
  ])("checks %s", (url) => {
    expect(ProfileField.requiresVerification(field, url)).toBe(true);
  });

  it.each([
    ["not https", "http://example.com"],
    ["an upper-case scheme", "HTTPS://example.com"],
    ["a user", "https://alice@example.com"],
    ["an upper-case host", "https://Example.com"],
    ["an IDN host", "https://bücher.example"],
    ["a path that normalizes", "https://example.com/a/../b"],
    ["no URL", undefined],
    ["text", "my site"],
  ])("does not check %s", (_, url) => {
    expect(ProfileField.requiresVerification(field, url)).toBe(false);
  });

  it("does not check a verified field again", () => {
    expect(
      ProfileField.requiresVerification({ ...field, verifiedAt: at }, "https://example.com"),
    ).toBe(false);
  });
});

describe("ProfileField.keepVerified", () => {
  it("keeps the verification of a value that stays, as Mastodon's fields_attributes=", () => {
    const previous = [
      { name: "site", value: "https://example.com", verifiedAt: at },
      { name: "blog", value: "https://blog.example", verifiedAt: at },
    ];
    expect(
      ProfileField.keepVerified(previous, [
        { name: "home", value: "https://example.com" },
        { name: "blog", value: "https://new.example" },
      ]),
    ).toEqual([
      { name: "home", value: "https://example.com", verifiedAt: at },
      { name: "blog", value: "https://new.example" },
    ]);
  });
});
