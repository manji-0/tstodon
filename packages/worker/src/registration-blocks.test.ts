import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { canonicalEmailHash } from "./registration-block-store";

const auth = (
  email: string,
  options?: Readonly<{ admin?: boolean }>,
): Promise<Record<string, string>> => authHeaders(email, options);

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

const BlockSchema = z.object({ id: z.string().min(1), canonical_email_hash: z.string().min(1) });

const DomainBlockSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  created_at: z.string().min(1),
  history: z.array(z.object({ day: z.string(), accounts: z.string(), uses: z.string() })),
});

const adminJson = async (
  email: string,
  path: string,
  init: Readonly<{ method?: string; body?: string }> = {},
): Promise<{ status: number; body: unknown }> =>
  json(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(await auth(email, { admin: true })),
    },
  });

describe("canonical email blocks", () => {
  it("blocks a canonical hash and refuses a respelled sign-up", async () => {
    const admin = "ceb-admin@example.com";
    // A fresh address that no other test authenticates as.
    const hash = await canonicalEmailHash("Casey.Block+spam@example.com");
    expect(hash).toBe(await canonicalEmailHash("caseyblock@example.com"));

    const created = await adminJson(admin, "/api/v1/admin/canonical_email_blocks", {
      method: "POST",
      body: JSON.stringify({ email: "Casey.Block+spam@example.com" }),
    });
    expect(created.status).toBe(200);
    const block = read(BlockSchema, created.body);
    expect(block.canonical_email_hash).toBe(hash);

    // A duplicate (any spelling) is refused.
    const duplicate = await adminJson(admin, "/api/v1/admin/canonical_email_blocks", {
      method: "POST",
      body: JSON.stringify({ email: "caseyblock@example.com" }),
    });
    expect(duplicate.status).toBe(422);

    // The test endpoint answers the matching block.
    const tested = await adminJson(admin, "/api/v1/admin/canonical_email_blocks/test", {
      method: "POST",
      body: JSON.stringify({ email: "casey.block@example.com" }),
    });
    expect(tested.status).toBe(200);
    expect(read(BlockSchema, tested.body).id).toBe(block.id);

    // Provisioning an account for any spelling is refused.
    await expect(signedInAccount("casey.block@example.com")).rejects.toThrow("RegistrationBlocked");

    // The list includes the block; deleting it lets the address in.
    const list = await adminJson(admin, "/api/v1/admin/canonical_email_blocks");
    expect(read(z.array(BlockSchema), list.body).map((row) => row.id)).toContain(block.id);
    const removed = await adminJson(admin, `/api/v1/admin/canonical_email_blocks/${block.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const allowed = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth("casey.block@example.com"),
    });
    expect(allowed.status).toBe(200);
  });
});

describe("email domain blocks", () => {
  it("blocks new accounts from a domain but keeps existing ones", async () => {
    const admin = "edb-admin@example.com";
    const existingEmail = "edb-existing@blocked-domain.example";
    // Provision first: the block only stops new sign-ups.
    expect(
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await auth(existingEmail),
        })
      ).status,
    ).toBe(200);

    const created = await adminJson(admin, "/api/v1/admin/email_domain_blocks", {
      method: "POST",
      body: JSON.stringify({ domain: "Blocked-Domain.example" }),
    });
    expect(created.status).toBe(200);
    const block = read(DomainBlockSchema, created.body);
    expect(block.domain).toBe("blocked-domain.example");
    expect(block.history).toHaveLength(5);
    // The existing account is counted on today's history entry.
    expect(Number(block.history[0]?.accounts)).toBeGreaterThanOrEqual(1);

    const duplicate = await adminJson(admin, "/api/v1/admin/email_domain_blocks", {
      method: "POST",
      body: JSON.stringify({ domain: "blocked-domain.example" }),
    });
    expect(duplicate.status).toBe(422);

    // A new address on that domain is refused; the existing account still works.
    await expect(signedInAccount("edb-new@blocked-domain.example")).rejects.toThrow(
      "RegistrationBlocked",
    );
    expect(
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await auth(existingEmail),
        })
      ).status,
    ).toBe(200);

    const single = await adminJson(admin, `/api/v1/admin/email_domain_blocks/${block.id}`);
    expect(single.status).toBe(200);
    expect(read(DomainBlockSchema, single.body).id).toBe(block.id);

    const removed = await adminJson(admin, `/api/v1/admin/email_domain_blocks/${block.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await auth("edb-new@blocked-domain.example"),
        })
      ).status,
    ).toBe(200);
  });
});
