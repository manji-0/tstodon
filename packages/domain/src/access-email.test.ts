import { describe, expect, it } from "vitest";
import { AccessEmail } from "./access-email";

describe("AccessEmail", () => {
  it("normalizes and accepts a well-formed address", () => {
    const parsed = AccessEmail.parse("  Alice@Example.COM ");
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value).toBe("alice@example.com");
      expect(AccessEmail.localPart(parsed.value)).toBe("alice");
      expect(AccessEmail.shortSuffix(parsed.value)).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it("rejects blank input", () => {
    const blank = AccessEmail.parse("   ");
    expect(blank.isErr()).toBe(true);
    if (blank.isErr()) {
      expect(blank.error.kind).toBe("Blank");
    }
  });

  it("rejects malformed domains and missing local parts", () => {
    for (const raw of ["not-an-email", "@example.com", "alice@", "alice@example", "a@b@c.com"]) {
      const parsed = AccessEmail.parse(raw);
      expect(parsed.isErr()).toBe(true);
      if (parsed.isErr()) {
        expect(parsed.error.kind).toBe("Invalid");
      }
    }
  });

  it("shortSuffix is stable for the same address", () => {
    const email = AccessEmail.parse("alice@example.com");
    expect(email.isOk()).toBe(true);
    if (!email.isOk()) {
      return;
    }
    expect(AccessEmail.shortSuffix(email.value)).toBe(AccessEmail.shortSuffix(email.value));
  });
});
