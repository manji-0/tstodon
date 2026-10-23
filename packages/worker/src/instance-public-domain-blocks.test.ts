import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { isLimitedFederation } from "./runtime-config";

const auth = (email: string, admin = false): Promise<Record<string, string>> =>
  authHeaders(email, { admin });

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
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

const PublicDomainBlockSchema = z.object({
  domain: z.string().min(1),
  digest: z.string().length(64),
  severity: z.string().min(1),
  comment: z.string().nullable(),
});

const createBlock = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/admin/domain_blocks", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email, true)) },
    body: JSON.stringify(body),
  });

describe("limited federation guards", () => {
  it("keeps peers and activity public without an allowlist", async () => {
    const peers = await json("/api/v1/instance/peers");
    expect(peers.status).toBe(200);
    expect(read(z.array(z.string()), peers.body)).toEqual([]);
    expect((await json("/api/v1/instance/activity")).status).toBe(200);
    expect(await isLimitedFederation({ FEDERATION_ALLOW_HOSTS: "" } as unknown as Env)).toBe(false);
    expect(
      await isLimitedFederation({
        FEDERATION_ALLOW_HOSTS: "a.example,b.example",
      } as unknown as Env),
    ).toBe(true);
  });
});

describe("public instance domain blocks", () => {
  it("lists moderated servers and hashes obfuscated domains", async () => {
    const email = "publicblocks-admin@example.com";
    const obfuscated = await createBlock(email, {
      domain: "public.example",
      severity: "suspend",
      obfuscate: true,
      public_comment: "Third-party bots",
      private_comment: "internal note",
    });
    expect(obfuscated.status).toBe(200);
    expect((await createBlock(email, { domain: "audit.example", severity: "noop" })).status).toBe(
      200,
    );
    expect(
      (await createBlock(email, { domain: "visible.example", severity: "silence" })).status,
    ).toBe(200);

    const response = await json("/api/v1/instance/domain_blocks");
    expect(response.status).toBe(200);
    const blocks = read(z.array(PublicDomainBlockSchema), response.body);
    const domains = blocks.map((block) => block.domain);
    expect(domains).toContain("visible.example");
    // `noop` stays private; obfuscated domains are published as their digest.
    expect(domains).not.toContain("audit.example");
    expect(domains).not.toContain("public.example");
    const hashed = blocks.find((block) => block.comment === "Third-party bots");
    expect(hashed?.domain).toBe(hashed?.digest);
    expect(hashed?.severity).toBe("suspend");
    // Private comments never leak.
    expect(JSON.stringify(response.body)).not.toContain("internal note");
  });

  it("reports weekly activity starting at Monday midnight", async () => {
    const response = await json("/api/v1/instance/activity");
    expect(response.status).toBe(200);
    const weeks = read(
      z.array(
        z.object({
          week: z.string().regex(/^\d+$/),
          statuses: z.string(),
          logins: z.string(),
          registrations: z.string(),
        }),
      ),
      response.body,
    );
    for (const entry of weeks) {
      const seconds = Number(entry.week);
      expect(Number.isFinite(seconds)).toBe(true);
      expect(seconds % 86_400).toBe(0);
      // Monday 00:00 UTC.
      expect(new Date(seconds * 1000).getUTCDay()).toBe(1);
    }
  });
});
