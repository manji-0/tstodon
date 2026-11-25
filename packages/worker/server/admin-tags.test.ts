import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  ApiAdminTag,
  ApiHashtag,
  ApiPreviewCard,
  ApiSearchResults,
  ApiStatus,
  ApiTrendsLink,
} from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";

/**
 * `/api/v1/admin/tags` and what its flags do: an unusable tag's timeline is
 * empty and it cannot be featured; an unusable or unlisted tag leaves
 * search and trends; `trendable: false` keeps it out of trends.
 */

const ADMIN = "admintags-admin@example.com";
const MEMBER = "admintags-member@example.com";

const call = async (
  method: string,
  path: string,
  options: Readonly<{ body?: unknown; email?: string; scopes?: ReadonlyArray<string> }> = {},
): Promise<Response> => {
  const email = options.email ?? ADMIN;
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: {
      ...(await authHeaders(email, {
        admin: email === ADMIN,
        ...(options.scopes ? { scopes: options.scopes } : {}),
      })),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
};

const ok = async <T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  options: Parameters<typeof call>[2] = {},
): Promise<T> => {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(schema, await response.json());
};

const post = (text: string) =>
  ok(ApiStatus, "POST", "/api/v1/statuses", { email: MEMBER, body: { status: text } });

describe("admin tags", () => {
  it("lists, shows and updates a stored tag", async () => {
    await post("first #AdminTagOne and #admintagtwo");
    const listed = await ok(z.array(ApiAdminTag), "GET", "/api/v1/admin/tags");
    expect(listed.map((tag) => tag.id)).toEqual(
      expect.arrayContaining(["admintagone", "admintagtwo"]),
    );
    const page = await call("GET", "/api/v1/admin/tags?limit=1");
    expect(page.headers.get("Link")).toContain('rel="next"');

    const shown = await ok(ApiAdminTag, "GET", "/api/v1/admin/tags/admintagone");
    expect(shown).toMatchObject({
      id: "admintagone",
      name: "admintagone",
      usable: true,
      listable: true,
      trendable: true,
      requires_review: true,
    });

    const updated = await ok(ApiAdminTag, "PUT", "/api/v1/admin/tags/admintagone", {
      body: { display_name: "AdminTagOne", trendable: true, listable: false },
    });
    expect(updated).toMatchObject({
      id: "admintagone",
      name: "AdminTagOne",
      listable: false,
      usable: true,
      trendable: true,
      requires_review: false,
    });

    // The display name may only change the case.
    expect(
      (await call("PUT", "/api/v1/admin/tags/admintagone", { body: { display_name: "Other" } }))
        .status,
    ).toBe(422);
    // ... and must be a hashtag name, whatever it normalizes to (`Tag::HASHTAG_NAME_RE`).
    expect(
      (
        await call("PUT", "/api/v1/admin/tags/admintagone", {
          body: { display_name: "Admin-TagOne!" },
        })
      ).status,
    ).toBe(422);
    expect((await call("GET", "/api/v1/admin/tags/neverstoredtag")).status).toBe(404);
    expect((await call("PUT", "/api/v1/admin/tags/neverstoredtag", { body: {} })).status).toBe(404);
  });

  it("is for admins with admin:read / admin:write", async () => {
    await post("scope #admintagscope");
    expect((await call("GET", "/api/v1/admin/tags", { email: MEMBER })).status).toBe(403);
    expect(
      (await call("GET", "/api/v1/admin/tags", { scopes: ["admin:read:accounts"] })).status,
    ).toBe(403);
    expect((await call("GET", "/api/v1/admin/tags", { scopes: ["admin:read"] })).status).toBe(200);
    expect(
      (
        await call("PUT", "/api/v1/admin/tags/admintagscope", {
          scopes: ["admin:read"],
          body: { usable: false },
        })
      ).status,
    ).toBe(403);
  });

  it("keeps an unusable tag off its timeline, featured tags, search and trends", async () => {
    await post("usable check #admintagbanned");
    const before = await ok(z.array(ApiStatus), "GET", "/api/v1/timelines/tag/admintagbanned");
    expect(before.length).toBe(1);
    const trendsBefore = await ok(z.array(ApiHashtag), "GET", "/api/v1/trends/tags?limit=20");
    expect(trendsBefore.map((tag) => tag.name)).toContain("admintagbanned");

    await ok(ApiAdminTag, "PUT", "/api/v1/admin/tags/admintagbanned", {
      body: { usable: false },
    });

    expect(await ok(z.array(ApiStatus), "GET", "/api/v1/timelines/tag/admintagbanned")).toEqual([]);
    const feature = await call("POST", "/api/v1/featured_tags", {
      email: MEMBER,
      body: { name: "admintagbanned" },
    });
    expect(feature.status).toBe(422);
    expect(
      (await call("POST", "/api/v1/tags/admintagbanned/feature", { email: MEMBER })).status,
    ).toBe(422);
    const search = await ok(ApiSearchResults, "GET", "/api/v2/search?q=admintagban&type=hashtags", {
      email: MEMBER,
    });
    expect(search.hashtags.map((tag) => tag.name)).not.toContain("admintagbanned");
    const trends = await ok(z.array(ApiHashtag), "GET", "/api/v1/trends/tags?limit=20");
    expect(trends.map((tag) => tag.name)).not.toContain("admintagbanned");
  });

  it("keeps an unlisted or untrendable tag out of search and trends", async () => {
    await post("listing #admintaghidden #admintagrejected");
    const searchFor = async (q: string) =>
      (
        await ok(ApiSearchResults, "GET", `/api/v2/search?q=${q}&type=hashtags`, { email: MEMBER })
      ).hashtags.map((tag) => tag.name);
    expect(await searchFor("admintaghid")).toContain("admintaghidden");

    await ok(ApiAdminTag, "PUT", "/api/v1/admin/tags/admintaghidden", {
      body: { listable: false },
    });
    await ok(ApiAdminTag, "PUT", "/api/v1/admin/tags/admintagrejected", {
      body: { trendable: false },
    });

    expect(await searchFor("admintaghid")).not.toContain("admintaghidden");
    // Unlisted is not unusable: the timeline still lists the post.
    expect(
      (await ok(z.array(ApiStatus), "GET", "/api/v1/timelines/tag/admintaghidden")).length,
    ).toBe(1);
    const trends = (await ok(z.array(ApiHashtag), "GET", "/api/v1/trends/tags?limit=20")).map(
      (tag) => tag.name,
    );
    expect(trends).not.toContain("admintaghidden");
    expect(trends).not.toContain("admintagrejected");
    // The admin trends list still shows them, with their state.
    const adminTrends = await ok(z.array(ApiAdminTag), "GET", "/api/v1/admin/trends/tags?limit=20");
    expect(adminTrends.find((tag) => tag.id === "admintagrejected")).toMatchObject({
      trendable: false,
      requires_review: false,
    });
  });

  it("rejects and approves a trending link by its URL", async () => {
    const url = "https://linktrend.example/review-me";
    const status = await post(`read ${url} today`);
    await ok(ApiStatus, "POST", `/api/v1/statuses/${status.id}/favourite`);
    const trending = async () =>
      (await ok(z.array(ApiTrendsLink), "GET", "/api/v1/trends/links?limit=20")).map(
        (link) => link.url,
      );
    expect(await trending()).toContain(url);
    const path = (verb: string) => `/api/v1/admin/trends/links/${encodeURIComponent(url)}/${verb}`;

    expect((await call("POST", path("approve"), { email: MEMBER })).status).toBe(403);
    expect((await ok(ApiPreviewCard, "POST", path("reject"))).url).toBe(url);
    expect(await trending()).not.toContain(url);
    expect((await ok(ApiPreviewCard, "POST", path("approve"))).url).toBe(url);
    expect(await trending()).toContain(url);
  });
});
