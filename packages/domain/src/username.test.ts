import { describe, expect, it } from "vitest";
import { AccessEmail } from "./access-email";
import { Username } from "./username";

describe("Username", () => {
  it("parses trimmed lowercase handles", () => {
    const parsed = Username.parse("  Alice_01 ");
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value).toBe("alice_01");
    }
  });

  it("rejects blank and invalid characters", () => {
    expect(Username.parse("").isErr()).toBe(true);
    expect(Username.parse("   ").isErr()).toBe(true);
    const invalid = Username.parse("alice-bob");
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) {
      expect(invalid.error.kind).toBe("InvalidCharacters");
    }
  });

  it("derives a sanitized handle from email local part", () => {
    const email = AccessEmail.parse("Alice-Bob+tag@Example.COM");
    expect(email.isOk()).toBe(true);
    if (!email.isOk()) {
      return;
    }
    const derived = Username.deriveFromEmail(email.value, false);
    expect(derived.isOk()).toBe(true);
    if (derived.isOk()) {
      expect(derived.value).toBe("alice_bobtag");
    }
  });

  it("falls back to user and appends a short suffix when taken", () => {
    const email = AccessEmail.parse("+++@example.com");
    expect(email.isOk()).toBe(true);
    if (!email.isOk()) {
      return;
    }
    const free = Username.deriveFromEmail(email.value, false);
    expect(free.isOk()).toBe(true);
    if (free.isOk()) {
      expect(free.value).toBe("user");
    }
    const taken = Username.deriveFromEmail(email.value, true);
    expect(taken.isOk()).toBe(true);
    if (taken.isOk()) {
      expect(taken.value).toMatch(/^user_[0-9a-f]{6}$/);
      expect(taken.value).toBe(`user_${AccessEmail.shortSuffix(email.value)}`);
    }
  });
});
