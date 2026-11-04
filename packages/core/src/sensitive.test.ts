/// <reference types="node" />
import { Console } from "node:console";
import { Writable } from "node:stream";
import { format, inspect } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { brandedNonEmptyString } from "./branded-id";
import { Sensitive } from "./sensitive";

const SECRET = "casey@example.com";

const consoleOutput = (log: (console: Console) => void): string => {
  const chunks: string[] = [];
  const sink = new Writable({
    write: (chunk: Buffer, _encoding: BufferEncoding, done: () => void) => {
      chunks.push(chunk.toString());
      done();
    },
  });
  log(new Console({ stdout: sink, stderr: sink }));
  return chunks.join("");
};

describe("Sensitive", () => {
  const secret = Sensitive.of(SECRET);
  const record = { email: secret, nested: { keys: [secret] } };

  it("reveals the value only through reveal()", () => {
    expect(secret.reveal()).toBe(SECRET);
  });

  it("redacts JSON, string coercion and error messages", () => {
    expect(JSON.stringify(record)).toBe('{"email":"[REDACTED]","nested":{"keys":["[REDACTED]"]}}');
    expect(String(secret)).toBe("[REDACTED]");
    // Lint already refuses these templates; the runtime redacts them anyway.
    // oxlint-disable-next-line typescript/restrict-template-expressions
    expect(`to ${secret}`).toBe("to [REDACTED]");
    // oxlint-disable-next-line typescript/restrict-template-expressions
    expect(new Error(`mail to ${secret} failed`).message).not.toContain(SECRET);
  });

  it("redacts util.inspect and every console format directive", () => {
    expect(inspect(record, { depth: 10 })).not.toContain(SECRET);
    expect(inspect(record, { showHidden: true, depth: 10 })).not.toContain(SECRET);
    expect(format("%s %o %O %j %d", secret, secret, record, record, secret)).not.toContain(SECRET);
    const printed = consoleOutput((console) => {
      console.log(secret, record);
      console.error("failed", { email: secret });
      console.dir(record, { depth: 10 });
      console.table([record]);
    });
    expect(printed).toContain("[REDACTED]");
    expect(printed).not.toContain(SECRET);
  });

  it("keeps the value out of the object's own properties", () => {
    expect(Object.values(secret)).not.toContain(SECRET);
    expect(Reflect.ownKeys(secret).map((key) => Reflect.get(secret, key))).not.toContain(SECRET);
    expect(Object.isFrozen(secret)).toBe(true);
    expect(() => structuredClone(secret)).toThrow();
  });

  it("wraps what its schema reads", () => {
    const schema = z.object({ email: Sensitive.schema(z.string().trim()) });
    const parsed = schema.parse({ email: ` ${SECRET} ` });
    expect(parsed.email.reveal()).toBe(SECRET);
    expect(JSON.stringify(parsed)).toBe('{"email":"[REDACTED]"}');
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
