import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { parseInstanceRules } from "./runtime-config";

const json = async (path: string): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const RuleSchema = z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }));

describe("instance rules", () => {
  it("serves configured rules from the instance vars", async () => {
    const response = await json("/api/v1/instance/rules");
    expect(response.status).toBe(200);
    const rules = read(RuleSchema, response.body);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((rule) => rule.text)).toContain("Be kind to others.");
  });

  it("includes rules on the v2 instance document", async () => {
    const response = await json("/api/v2/instance");
    expect(response.status).toBe(200);
    const body = read(z.object({ rules: RuleSchema.optional() }), response.body);
    expect(body.rules?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("parseInstanceRules", () => {
  it("maps strings and objects with hints to ids", () => {
    expect(parseInstanceRules('["first","second"]')).toEqual([
      { id: "1", text: "first" },
      { id: "2", text: "second" },
    ]);
    expect(parseInstanceRules('[{"text":"be nice","hint":"or else"}]')).toEqual([
      { id: "1", text: "be nice", hint: "or else" },
    ]);
  });

  it("returns no rules for empty or malformed input", () => {
    expect(parseInstanceRules("")).toEqual([]);
    expect(parseInstanceRules("   ")).toEqual([]);
    expect(parseInstanceRules("not json")).toEqual([]);
    expect(parseInstanceRules('{"text":"one"}')).toEqual([]);
    expect(parseInstanceRules("[123]")).toEqual([]);
  });
});
