import { describe, expect, it } from "vitest";
import { brandedNonEmptyString } from "./branded-id";
import { Sensitive } from "./sensitive";

describe("Sensitive", () => {
  it("unwraps the secret while redacting string and JSON forms", () => {
    const secret = Sensitive.of("token-value");
    expect(secret.unwrap()).toBe("token-value");
    expect(secret.toString()).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
  });
});

describe("brandedNonEmptyString", () => {
  const Brand = Symbol("TestBrand");
  const schema = brandedNonEmptyString<typeof Brand>();

  it("trims and brands non-empty strings", () => {
    expect(schema.parse("  hello  ")).toBe("hello");
  });

  it("rejects blank and whitespace-only input", () => {
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("   ").success).toBe(false);
  });
});
