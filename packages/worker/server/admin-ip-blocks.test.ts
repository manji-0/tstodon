import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAdminIpBlock } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { signAccessJwt } from "../test/access-jwt-fixture";
import { authHeaders } from "../test/auth-fixture";

/**
 * `/api/v1/admin/ip_blocks` and their enforcement: `no_access` refuses every
 * request from the range (federation included), `sign_up_block` refuses a
 * sign-up, `sign_up_requires_approval` holds the new account. The addresses
 * here (TEST-NET and documentation ranges) are used by no other test, since
 * the block list is cached per isolate.
 */

const ADMIN = "ipblocks-admin@example.com";

const call = async (
  method: string,
  path: string,
  options: Readonly<{
    body?: unknown;
    email?: string;
    admin?: boolean;
    ip?: string;
    scopes?: ReadonlyArray<string>;
  }> = {},
): Promise<Response> => {
  const email = options.email ?? ADMIN;
  const headers: Record<string, string> = {
    ...(await authHeaders(email, {
      admin: options.admin ?? email === ADMIN,
      ...(options.scopes ? { scopes: options.scopes } : {}),
    })),
    ...(options.ip ? { "CF-Connecting-IP": options.ip } : {}),
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
  };
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
};

const createBlock = async (body: Record<string, unknown>) => {
  const response = await call("POST", "/api/v1/admin/ip_blocks", { body });
  expect(response.status, JSON.stringify(body)).toBe(200);
  return expectContract(ApiAdminIpBlock, await response.json());
};

describe("admin IP blocks", () => {
  it("creates, reads, updates, lists and deletes a block", async () => {
    const created = await createBlock({
      ip: "192.0.2.77/24",
      severity: "sign_up_block",
      comment: " spam wave ",
      expires_in: 3600,
    });
    // The range is stored as its network, as Mastodon's inet renders it.
    expect(created).toMatchObject({
      ip: "192.0.2.0/24",
      severity: "sign_up_block",
      comment: "spam wave",
    });
    expect(Date.parse(created.expires_at ?? "") - Date.now()).toBeGreaterThan(3500_000);

    const shown = await call("GET", `/api/v1/admin/ip_blocks/${created.id}`);
    expect(expectContract(ApiAdminIpBlock, await shown.json()).id).toBe(created.id);

    const updated = await call("PUT", `/api/v1/admin/ip_blocks/${created.id}`, {
      body: { severity: "sign_up_requires_approval", expires_in: null },
    });
    expect(expectContract(ApiAdminIpBlock, await updated.json())).toMatchObject({
      ip: "192.0.2.0/24",
      severity: "sign_up_requires_approval",
      comment: "spam wave",
      expires_at: null,
    });

    const v6 = await createBlock({ ip: "2001:DB8:0:0::1/48", severity: "sign_up_block" });
    expect(v6.ip).toBe("2001:db8::/48");

    const page = await call("GET", "/api/v1/admin/ip_blocks?limit=1");
    const listed = expectContract(z.array(ApiAdminIpBlock), await page.json());
    expect(listed.map((block) => block.id)).toEqual([v6.id]);
    expect(page.headers.get("Link")).toContain(`max_id=${v6.id}`);

    expect((await call("DELETE", `/api/v1/admin/ip_blocks/${created.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/v1/admin/ip_blocks/${v6.id}`)).status).toBe(200);
    expect((await call("GET", `/api/v1/admin/ip_blocks/${created.id}`)).status).toBe(404);
    expect((await call("PUT", `/api/v1/admin/ip_blocks/${created.id}`, { body: {} })).status).toBe(
      404,
    );
  });

  it("validates the range, severity, expiry and uniqueness", async () => {
    const refused = async (body: Record<string, unknown>) => {
      const response = await call("POST", "/api/v1/admin/ip_blocks", { body });
      expect(response.status, JSON.stringify(body)).toBe(422);
    };
    await refused({ severity: "no_access" });
    await refused({ ip: "300.1.1.1", severity: "no_access" });
    await refused({ ip: "198.51.100.0/33", severity: "no_access" });
    await refused({ ip: "example.com", severity: "no_access" });
    await refused({ ip: "198.51.100.1" });
    await refused({ ip: "198.51.100.1", severity: "silence" });
    await refused({ ip: "198.51.100.1", severity: "no_access", expires_in: -5 });
    const block = await createBlock({ ip: "198.51.100.1", severity: "sign_up_block" });
    expect(block.ip).toBe("198.51.100.1/32");
    await refused({ ip: "198.51.100.1/32", severity: "no_access" });
    expect((await call("DELETE", `/api/v1/admin/ip_blocks/${block.id}`)).status).toBe(200);
  });

  it("is for admins with the ip_blocks scope", async () => {
    expect((await SELF.fetch("https://example.com/api/v1/admin/ip_blocks")).status).toBe(401);
    expect(
      (await call("GET", "/api/v1/admin/ip_blocks", { email: "ipblocks-member@example.com" }))
        .status,
    ).toBe(403);
    expect(
      (await call("GET", "/api/v1/admin/ip_blocks", { scopes: ["admin:read:accounts"] })).status,
    ).toBe(403);
    expect(
      (await call("GET", "/api/v1/admin/ip_blocks", { scopes: ["admin:read:ip_blocks"] })).status,
    ).toBe(200);
    expect(
      (
        await call("POST", "/api/v1/admin/ip_blocks", {
          scopes: ["admin:read"],
          body: { ip: "198.51.100.9", severity: "no_access" },
        })
      ).status,
    ).toBe(403);
  });

  it("refuses every request from a no_access range, federation included", async () => {
    const block = await createBlock({ ip: "203.0.113.0/25", severity: "no_access" });
    const blocked = await SELF.fetch("https://example.com/api/v1/instance", {
      headers: { "CF-Connecting-IP": "203.0.113.20" },
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toBe("Forbidden\n");
    const inbox = await SELF.fetch("https://example.com/inbox", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.21", "content-type": "application/activity+json" },
      body: "{}",
    });
    expect(inbox.status).toBe(403);
    // An IPv4-mapped IPv6 address is the IPv4 address.
    expect(
      (
        await SELF.fetch("https://example.com/api/v1/instance", {
          headers: { "CF-Connecting-IP": "::ffff:203.0.113.22" },
        })
      ).status,
    ).toBe(403);
    // Outside the range, or with no client address, the request goes through.
    expect(
      (
        await SELF.fetch("https://example.com/api/v1/instance", {
          headers: { "CF-Connecting-IP": "203.0.113.200" },
        })
      ).status,
    ).toBe(200);
    expect((await SELF.fetch("https://example.com/api/v1/instance")).status).toBe(200);

    // Lifting the block takes effect at once in this isolate.
    expect((await call("DELETE", `/api/v1/admin/ip_blocks/${block.id}`)).status).toBe(200);
    expect(
      (
        await SELF.fetch("https://example.com/api/v1/instance", {
          headers: { "CF-Connecting-IP": "203.0.113.20" },
        })
      ).status,
    ).toBe(200);
  });

  it("does not enforce an expired block", async () => {
    const block = await createBlock({ ip: "203.0.113.128/26", severity: "no_access" });
    await env.DB.prepare(`UPDATE ip_blocks SET expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), block.id)
      .run();
    // Any change drops the cached list; the update above went around the API.
    expect(
      (await call("PUT", `/api/v1/admin/ip_blocks/${block.id}`, { body: { comment: "old" } }))
        .status,
    ).toBe(200);
    expect(
      (
        await SELF.fetch("https://example.com/api/v1/instance", {
          headers: { "CF-Connecting-IP": "203.0.113.130" },
        })
      ).status,
    ).toBe(200);
    await call("DELETE", `/api/v1/admin/ip_blocks/${block.id}`);
  });

  it("refuses or holds a sign-up from a blocked range", async () => {
    const refusing = await createBlock({ ip: "198.18.0.0/24", severity: "sign_up_block" });
    const holding = await createBlock({
      ip: "198.18.1.0/24",
      severity: "sign_up_requires_approval",
    });
    const signIn = async (email: string, ip: string) =>
      // The test Access key is accepted only on a local host (test/passkey-browser.ts).
      SELF.fetch("http://127.0.0.1/auth/sign_in", {
        headers: {
          "Cf-Access-Jwt-Assertion": await signAccessJwt({ email }),
          "CF-Connecting-IP": ip,
        },
      });
    const account = (email: string) =>
      env.DB.prepare(
        `SELECT a.id, COALESCE(f.pending, 0) AS pending FROM accounts a
         LEFT JOIN account_flags f ON f.account_id = a.id WHERE a.access_email = ?`,
      )
        .bind(email)
        .first();

    await signIn("ipblocked@mail.example", "198.18.0.5");
    expect(await account("ipblocked@mail.example")).toBeNull();

    await signIn("ipheld@mail.example", "198.18.1.5");
    const held = await account("ipheld@mail.example");
    expect(held).toMatchObject({ pending: 1 });
    // The sign-up address is recorded for Admin::Account#ips.
    const ips = await env.DB.prepare(`SELECT ip FROM account_ips WHERE account_id = ?`)
      .bind(z.object({ id: z.string() }).parse(held).id)
      .all();
    expect(ips.results).toEqual([{ ip: "198.18.1.5" }]);

    await signIn("ipopen@mail.example", "198.18.2.5");
    expect(await account("ipopen@mail.example")).toMatchObject({ pending: 0 });

    await call("DELETE", `/api/v1/admin/ip_blocks/${refusing.id}`);
    await call("DELETE", `/api/v1/admin/ip_blocks/${holding.id}`);
  });
});
