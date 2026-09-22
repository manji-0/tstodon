import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "./schema-result";
import { Sensitive } from "./sensitive";

describe("schemaResult", () => {
  it("returns Ok for valid input", () => {
    const parse = schemaResult(z.object({ kind: z.literal("Ready") }));
    const result = parse({ kind: "Ready" });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.kind).toBe("Ready");
    }
  });

  it("returns ValidationError for invalid input", () => {
    const parse = schemaResult(z.object({ kind: z.literal("Ready") }));
    const result = parse({ kind: "Nope" });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe("ValidationError");
    }
  });
});

describe("Sensitive", () => {
  it("redacts on JSON serialization", () => {
    expect(JSON.stringify({ email: Sensitive.of("a@example.com") })).toBe('{"email":"[REDACTED]"}');
  });
});
