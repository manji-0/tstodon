import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

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

const DomainBlockSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  severity: z.string().min(1),
  reject_media: z.boolean(),
  reject_reports: z.boolean(),
  obfuscate: z.boolean(),
  private_comment: z.string().nullable(),
  public_comment: z.string().nullable(),
  created_at: z.string().min(1),
});

const create = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/admin/domain_blocks", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email, true)) },
    body: JSON.stringify(body),
  });

describe("admin domain blocks", () => {
  it("creates, reads, updates, and deletes a block", async () => {
    const email = "admindomain-admin@example.com";
    expect((await json("/api/v1/admin/domain_blocks")).status).toBe(401);
    expect(
      (
        await json("/api/v1/admin/domain_blocks", {
          headers: await auth("admindomain-plain@example.com"),
        })
      ).status,
    ).toBe(403);

    const created = await create(email, {
      domain: "https://Bad.Example/users/x",
      severity: "suspend",
      reject_media: true,
      private_comment: "spam farm",
    });
    expect(created.status).toBe(200);
    const block = read(DomainBlockSchema, created.body);
    expect(block.domain).toBe("bad.example");
    expect(block.severity).toBe("suspend");
    expect(block.reject_media).toBe(true);
    expect(block.private_comment).toBe("spam farm");

    const list = await json("/api/v1/admin/domain_blocks", { headers: await auth(email, true) });
    expect(read(z.array(DomainBlockSchema), list.body).map((entry) => entry.domain)).toEqual([
      "bad.example",
    ]);
    const fetched = await json(`/api/v1/admin/domain_blocks/${block.id}`, {
      headers: await auth(email, true),
    });
    expect(read(DomainBlockSchema, fetched.body).domain).toBe("bad.example");

    expect((await create(email, { domain: "bad.example" })).status).toBe(422);
    expect((await create(email, { domain: "example.com" })).status).toBe(422);

    const updated = await json(`/api/v1/admin/domain_blocks/${block.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email, true)) },
      body: JSON.stringify({ severity: "silence", public_comment: "limited" }),
    });
    expect(updated.status).toBe(200);
    const edited = read(DomainBlockSchema, updated.body);
    expect(edited.severity).toBe("silence");
    expect(edited.public_comment).toBe("limited");
    expect(edited.reject_media).toBe(true);

    expect(
      (
        await json(`/api/v1/admin/domain_blocks/${block.id}`, {
          method: "DELETE",
          headers: await auth(email, true),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await json(`/api/v1/admin/domain_blocks/${block.id}`, {
          method: "DELETE",
          headers: await auth(email, true),
        })
      ).status,
    ).toBe(404);
  });

  it("refuses to resolve actors on a suspended domain", async () => {
    const email = "admindomain-suspend@example.com";
    const blocked = await create(email, { domain: "suspended.example", severity: "suspend" });
    expect(blocked.status).toBe(200);

    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetched += 1;
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const resolved = await json("/api/v2/search?q=@bob@suspended.example&resolve=true", {
        headers: await auth(email),
      });
      expect(resolved.status).toBe(200);
      expect(
        read(z.object({ accounts: z.array(z.object({ id: z.string() })) }), resolved.body).accounts,
      ).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
    // Nothing was fetched for the suspended host.
    expect(fetched).toBe(0);
  });
});
