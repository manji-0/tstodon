import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { queryAccountsLimit, queryAdminLimit, queryLimit, queryNotificationsLimit } from "./http";
import { generateAccountKeys } from "./keys";
import { nowIso } from "./clock";

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

const AccountListSchema = z.array(z.object({ id: z.string().min(1) }));

/** Mastodon's documented page sizes, which differ per collection family. */
describe("collection limits", () => {
  it("clamps each family to its documented maximum", () => {
    // Status collections: 20 by default, 40 max.
    expect(queryLimit(undefined)).toBe(20);
    expect(queryLimit("500")).toBe(40);
    // Account collections and notifications: 40 default, 80 max.
    expect(queryAccountsLimit(undefined)).toBe(40);
    expect(queryAccountsLimit("500")).toBe(80);
    expect(queryNotificationsLimit(undefined)).toBe(40);
    expect(queryNotificationsLimit("500")).toBe(80);
    // Admin lists: 100 default, 200 max.
    expect(queryAdminLimit(undefined)).toBe(100);
    expect(queryAdminLimit("500")).toBe(200);
    // A nonsense or absent value falls back rather than failing.
    expect(queryAccountsLimit("lots")).toBe(40);
    expect(queryAdminLimit("0")).toBe(100);
  });

  it("returns more than forty accounts on a directory page", async () => {
    // The accounts table is seeded directly: a real account per follower would
    // mean forty RSA key pairs.
    const keys = await generateAccountKeys();
    const created = nowIso();
    const seeded: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      // Ids are numeric entity ids and usernames are `[a-z0-9_]+`.
      const id = String(9_000_000_000_000_000_000n + BigInt(index));
      const username = `cap_account_${String(index).padStart(2, "0")}`;
      seeded.push(id);
      await env.DB.prepare(
        `INSERT INTO accounts (id, username, access_email, display_name, locked, default_post_visibility,
           default_quote_policy, public_key_pem, private_key_jwk, created_at, updated_at, bio_text)
         VALUES (?, ?, ?, ?, 0, 'public', 'public', ?, ?, ?, ?, '')`,
      )
        .bind(
          id,
          username,
          `${username}@example.com`,
          username,
          keys.publicKeyPem,
          keys.privateKeyJwk,
          created,
          created,
        )
        .run();
    }

    const directory = await json("/api/v1/directory?limit=80&order=new");
    expect(directory.status).toBe(200);
    const listed = read(AccountListSchema, directory.body);
    expect(listed).toHaveLength(45);
    for (const id of seeded) {
      expect(listed.map((account) => account.id)).toContain(id);
    }

    // Forty is still a page, and the admin list defaults to one hundred.
    expect(read(AccountListSchema, (await json("/api/v1/directory?limit=40")).body)).toHaveLength(
      40,
    );

    const adminHeaders = await auth("limits-admin@example.com", { admin: true });
    const admin = await json("/api/v1/admin/accounts", { headers: adminHeaders });
    expect(admin.status).toBe(200);
    // The documented default is 100, so the page is not clamped to 40 (the
    // admin's own account is one of them).
    const adminIds = read(AccountListSchema, admin.body).map((account) => account.id);
    expect(adminIds.length).toBeGreaterThan(40);
    for (const id of seeded) {
      expect(adminIds).toContain(id);
    }

    const capped = await json("/api/v1/admin/accounts?limit=200", { headers: adminHeaders });
    expect(read(AccountListSchema, capped.body).length).toBeGreaterThan(40);
  });

  it("pages endorsements with limit", async () => {
    const owner = "limits-endorser@example.com";
    const credentials = async (email: string): Promise<string> => {
      const response = await json("/api/v1/accounts/verify_credentials", {
        headers: await auth(email),
      });
      return read(z.object({ id: z.string().min(1) }), response.body).id;
    };
    const first = await credentials("limits-endorsed-a@example.com");
    const second = await credentials("limits-endorsed-b@example.com");
    for (const id of [first, second]) {
      const endorsed = await json(`/api/v1/accounts/${id}/endorse`, {
        method: "POST",
        headers: await auth(owner),
      });
      expect(endorsed.status).toBe(200);
    }

    const all = await json("/api/v1/endorsements", { headers: await auth(owner) });
    expect(read(AccountListSchema, all.body)).toHaveLength(2);

    const limited = await json("/api/v1/endorsements?limit=1", { headers: await auth(owner) });
    expect(read(AccountListSchema, limited.body)).toHaveLength(1);

    const publicList = await json(
      `/api/v1/accounts/${await credentials(owner)}/endorsements?limit=1`,
    );
    expect(read(AccountListSchema, publicList.body)).toHaveLength(1);
  });
});
