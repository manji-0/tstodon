import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount, ApiAdminDomainAllow, ApiConversation, ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";

const request = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://example.com${path}`, { headers });

const send = async (email: string, path: string, body: unknown = {}): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

const me = async (email: string) =>
  expectContract(
    ApiAccount,
    await (await request("/api/v1/accounts/verify_credentials", await authHeaders(email))).json(),
  );

const page = async <T>(
  schema: z.ZodType<T>,
  path: string,
  headers: Record<string, string> = {},
): Promise<Readonly<{ items: T[]; link: string | null }>> => {
  const response = await request(path, headers);
  expect(response.status, path).toBe(200);
  return {
    items: expectContract(z.array(schema), await response.json()),
    link: response.headers.get("Link"),
  };
};

/** `limit` read as Mastodon v4.7.5's `Api::BaseController#limit_param`. */
describe("limit_param", () => {
  it("reads limit with Ruby's to_i and abs on an account's statuses", async () => {
    const email = "limit-author@example.com";
    const author = await me(email);
    for (const index of [1, 2, 3]) {
      await send(email, "/api/v1/statuses", { status: `post ${index}` });
    }
    const statuses = (query: string) =>
      page(ApiStatus, `/api/v1/accounts/${author.id}/statuses${query}`);

    expect((await statuses("")).items).toHaveLength(3);
    // `"-2".to_i.abs` is 2.
    expect((await statuses("?limit=-2")).items).toHaveLength(2);
    // `"1abc".to_i` is 1, `" 2"` and `"+2"` are 2, `"1_0"` is 10.
    expect((await statuses("?limit=1abc")).items).toHaveLength(1);
    expect((await statuses("?limit=%202")).items).toHaveLength(2);
    expect((await statuses("?limit=%2B2")).items).toHaveLength(2);
    expect((await statuses("?limit=1_0")).items).toHaveLength(3);
    // Present but not a number: `to_i` is 0, and the page is empty.
    for (const query of ["?limit=0", "?limit=abc", "?limit=", "?limit=-0", "?limit=0x10"]) {
      const empty = await statuses(query);
      expect(empty.items, query).toEqual([]);
      expect(empty.link, query).toBeNull();
    }
  });

  it("gives an empty page for limit=0 on an account list", async () => {
    const email = "limit-blocker@example.com";
    for (const other of ["limit-blocked-a@example.com", "limit-blocked-b@example.com"]) {
      await send(email, `/api/v1/accounts/${(await me(other)).id}/block`);
    }
    const headers = await authHeaders(email);
    const blocks = (query: string) => page(ApiAccount, `/api/v1/blocks${query}`, headers);

    expect((await blocks("")).items).toHaveLength(2);
    expect((await blocks("?limit=-1")).items).toHaveLength(1);
    expect((await blocks("?limit=0")).items).toEqual([]);
    expect((await blocks("?limit=nope")).items).toEqual([]);
  });

  it("gives an empty conversation page for limit=0 with min_id", async () => {
    const email = "limit-dm-sender@example.com";
    const recipient = await me("limit-dm-recipient@example.com");
    await send(email, "/api/v1/statuses", {
      status: `@${recipient.username} hello`,
      visibility: "direct",
    });
    const headers = await authHeaders(email);
    expect((await page(ApiConversation, "/api/v1/conversations", headers)).items).toHaveLength(1);
    expect(
      (await page(ApiConversation, "/api/v1/conversations?limit=0&min_id=0", headers)).items,
    ).toEqual([]);
  });

  it("caps admin domain allows at 500, as MAX_LIMIT", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 210)
       INSERT INTO domain_allows (id, domain, created_at)
       SELECT printf('%d', 8100000000000000000 + i), 'limit-allow-' || i || '.example', '2026-01-01T00:00:00.000Z'
       FROM n`,
    ).run();
    const headers = await authHeaders("limit-admin@example.com", { admin: true });
    const allows = (query: string) =>
      page(ApiAdminDomainAllow, `/api/v1/admin/domain_allows${query}`, headers);
    expect((await allows("")).items).toHaveLength(100);
    expect((await allows("?limit=300")).items).toHaveLength(210);
    expect((await allows("?limit=-150")).items).toHaveLength(150);
    await env.DB.prepare("DELETE FROM domain_allows WHERE domain LIKE 'limit-allow-%'").run();
  });

  it("answers search with 20 results by default and refuses a negative limit", async () => {
    const email = "limit-searcher@example.com";
    for (let index = 0; index < 22; index += 1) {
      await send(email, "/api/v1/statuses", {
        status: `#limitsearch${String(index).padStart(2, "0")}`,
      });
    }
    const headers = await authHeaders(email);
    const search = (query: string) =>
      request(`/api/v2/search?q=limitsearch&type=hashtags${query}`, headers);
    const Hashtags = z.object({ hashtags: z.array(z.object({ name: z.string() })) });

    const byDefault = await search("");
    expect(byDefault.status).toBe(200);
    expect(expectContract(Hashtags, await byDefault.json()).hashtags).toHaveLength(20);

    const empty = await search("&limit=0");
    expect(expectContract(Hashtags, await empty.json()).hashtags).toEqual([]);

    // `require_valid_pagination_options!`
    for (const query of ["&limit=-1", "&offset=-1"]) {
      const refused = await search(query);
      expect(refused.status, query).toBe(400);
      expect(await refused.json()).toEqual({
        error: "Pagination values for `offset` and `limit` must be positive",
      });
    }
  });
});
