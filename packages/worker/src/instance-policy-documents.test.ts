import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import {
  extendedDescription,
  parseInstanceRules,
  privacyPolicy,
  termsOfService,
} from "./runtime-config";

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

describe("instance policy documents", () => {
  it("serves the configured extended description and privacy policy", async () => {
    const extended = await json("/api/v1/instance/extended_description");
    expect(extended.status).toBe(200);
    const description = read(
      z.object({ content: z.string().min(1), updated_at: z.string().nullable() }),
      extended.body,
    );
    expect(description.content).toContain("local-first");
    expect(description.updated_at).toBeNull();

    const privacy = await json("/api/v1/instance/privacy_policy");
    expect(privacy.status).toBe(200);
    const policy = read(
      z.object({ content: z.string().min(1), updated_at: z.string().nullable() }),
      privacy.body,
    );
    expect(policy.content).toContain("federation");
    expect(policy.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("serves terms of service by effective date", async () => {
    const current = await json("/api/v1/instance/terms_of_service");
    expect(current.status).toBe(200);
    const terms = read(
      z.object({
        effective_date: z.string().min(1),
        effective: z.boolean(),
        content: z.string().min(1),
        succeeded_by: z.string().nullable(),
      }),
      current.body,
    );
    expect(terms.effective_date).toBe("2026-01-01");
    expect(terms.effective).toBe(true);

    const byDate = await json(`/api/v1/instance/terms_of_service/${terms.effective_date}`);
    expect(byDate.status).toBe(200);
    expect(read(z.object({ content: z.string().min(1) }), byDate.body).content).toBe(terms.content);

    expect((await json("/api/v1/instance/terms_of_service/1999-01-01")).status).toBe(404);
  });

  it("treats malformed or empty configuration as absent", () => {
    const empty = {} as Env;
    expect(extendedDescription(empty)).toBeUndefined();
    expect(privacyPolicy(empty)).toBeUndefined();
    expect(termsOfService(empty)).toBeUndefined();

    const malformed = {
      INSTANCE_EXTENDED_DESCRIPTION: "not json",
      INSTANCE_PRIVACY_POLICY: '{"updated_at":"x"}',
      INSTANCE_TERMS_OF_SERVICE: '{"content":"<p>x</p>","effective_date":"soon"}',
    } as unknown as Env;
    expect(extendedDescription(malformed)).toBeUndefined();
    expect(privacyPolicy(malformed)).toBeUndefined();
    expect(termsOfService(malformed)).toBeUndefined();
    expect(parseInstanceRules("")).toEqual([]);
  });
});
