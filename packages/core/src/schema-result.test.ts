import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  compileSchema,
  hasCompiledFastPath,
  peekCompiledFastPath,
  schemaResult,
  warmSchemas,
} from "./schema-result";
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

  it("caches the parse function for the same schema", () => {
    const schema = z.object({ id: z.string().min(1) });
    expect(schemaResult(schema)).toBe(schemaResult(schema));
  });
});

describe("compileSchema", () => {
  it("installs a compiled fast path for object schemas", () => {
    const schema = z.object({
      username: z.string(),
      xp: z.number(),
    });
    const compiled = compileSchema(schema);
    expect(hasCompiledFastPath(schema)).toBe(true);
    expect(compiled.parse({ username: "billie", xp: 100 })).toEqual({
      username: "billie",
      xp: 100,
    });
  });

  it("keeps Ok/Err parity between raw and compiled schemaResult paths", () => {
    const raw = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("Create"), id: z.string().min(1) }),
      z.object({ kind: z.literal("Delete"), id: z.string().min(1) }),
    ]);
    const compiled = compileSchema(raw);
    const parseRaw = schemaResult(raw);
    const parseCompiled = schemaResult(compiled);

    const valid = { kind: "Create", id: "act-1" };
    const invalid = { kind: "Create", id: "" };

    const rawOk = parseRaw(valid);
    const compiledOk = parseCompiled(valid);
    expect(rawOk.isOk()).toBe(true);
    expect(compiledOk.isOk()).toBe(true);
    if (rawOk.isOk() && compiledOk.isOk()) {
      expect(compiledOk.value).toEqual(rawOk.value);
    }

    const rawErr = parseRaw(invalid);
    const compiledErr = parseCompiled(invalid);
    expect(rawErr.isErr()).toBe(true);
    expect(compiledErr.isErr()).toBe(true);
    if (rawErr.isErr() && compiledErr.isErr()) {
      expect(compiledErr.error.kind).toBe(rawErr.error.kind);
      expect(compiledErr.error.issues.length).toBeGreaterThan(0);
      expect(rawErr.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("warmSchemas compiles every provided schema at module-init time", () => {
    const objectSchema = z.object({ title: z.string() });
    const arraySchema = z.array(z.object({ n: z.number().int() }));
    expect(peekCompiledFastPath(objectSchema)).toBe(false);
    warmSchemas([objectSchema, arraySchema]);
    expect(peekCompiledFastPath(objectSchema)).toBe(true);
    expect(peekCompiledFastPath(arraySchema)).toBe(true);
    expect(hasCompiledFastPath(objectSchema)).toBe(true);
    expect(hasCompiledFastPath(arraySchema)).toBe(true);
  });

  it("peekCompiledFastPath does not compile on miss", () => {
    const cold = z.object({ cold: z.string() });
    expect(peekCompiledFastPath(cold)).toBe(false);
    expect(peekCompiledFastPath(cold)).toBe(false);
  });
});

describe("Sensitive", () => {
  it("redacts on JSON serialization", () => {
    expect(JSON.stringify({ email: Sensitive.of("a@example.com") })).toBe('{"email":"[REDACTED]"}');
  });
});
