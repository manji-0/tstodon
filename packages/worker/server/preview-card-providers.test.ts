import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAdminPreviewCardProvider, ApiStatus, ApiTrendsLink } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { PREVIEW_CARD_PROVIDERS_BY_DOMAIN_SQL } from "./preview-card-provider-store";
import { handleScheduled } from "./scheduled-handler";

/**
 * `/api/v1/admin/trends/links/publishers` as Mastodon v4.7.5's
 * `PreviewCardProvidersController`: `PreviewCardProvider` rows, newest id
 * first, paged by `max_id` with a `Link`; approve and reject review a row
 * by its id.
 */

const ADMIN = "providers-admin@example.com";
const MEMBER = "providers-member@example.com";
const PUBLISHERS = "/api/v1/admin/trends/links/publishers";

const call = async (method: string, path: string, email = ADMIN): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: await authHeaders(email, { admin: email === ADMIN }),
  });

const ok = async <T>(schema: z.ZodType<T>, method: string, path: string): Promise<T> => {
  const response = await call(method, path);
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(schema, await response.json());
};

const providers = (query = "") =>
  ok(z.array(ApiAdminPreviewCardProvider), "GET", PUBLISHERS + query);

const fireSixHourlyCron = async (): Promise<void> => {
  const ctx = createExecutionContext();
  await handleScheduled(
    { cron: "17 */6 * * *", scheduledTime: Date.now(), noRetry: () => undefined },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
};

const insertProviders = async (domains: ReadonlyArray<string>): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch(
    domains.map((domain) =>
      env.DB.prepare(
        "INSERT INTO preview_card_providers (domain, created_at, updated_at) VALUES (?, ?, ?)",
      ).bind(domain, now, now),
    ),
  );
};

describe("admin trend publishers", () => {
  it("writes a provider when a host first trends, and reviews it by its id", async () => {
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(MEMBER)) },
      body: JSON.stringify({ status: "read https://publisher.example/story today" }),
    });
    const status = expectContract(ApiStatus, await posted.json());
    await ok(ApiStatus, "POST", `/api/v1/statuses/${status.id}/favourite`);

    // A host has no provider until the review scheduler writes one.
    expect((await providers()).map((provider) => provider.domain)).not.toContain(
      "publisher.example",
    );
    await fireSixHourlyCron();
    const listed = (await providers()).find((provider) => provider.domain === "publisher.example");
    expect(listed).toEqual({
      id: expect.any(Number),
      domain: "publisher.example",
      trendable: null,
      reviewed_at: null,
      requested_review_at: expect.any(String),
      requires_review: true,
    });
    if (listed === undefined) {
      return;
    }
    // A second run keeps the row as it is.
    await fireSixHourlyCron();
    expect(
      (await providers()).filter((provider) => provider.domain === "publisher.example"),
    ).toEqual([listed]);

    const linksBefore = await ok(z.array(ApiTrendsLink), "GET", "/api/v1/trends/links?limit=20");
    expect(linksBefore.map((link) => link.url)).toContain("https://publisher.example/story");

    const rejected = await ok(
      ApiAdminPreviewCardProvider,
      "POST",
      `${PUBLISHERS}/${listed.id}/reject`,
    );
    expect(rejected).toMatchObject({ id: listed.id, trendable: false, requires_review: false });
    expect(rejected.reviewed_at).not.toBeNull();
    expect(rejected.requested_review_at).toBe(listed.requested_review_at);
    const linksAfter = await ok(z.array(ApiTrendsLink), "GET", "/api/v1/trends/links?limit=20");
    expect(linksAfter.map((link) => link.url)).not.toContain("https://publisher.example/story");

    const approved = await ok(
      ApiAdminPreviewCardProvider,
      "POST",
      `${PUBLISHERS}/${listed.id}/approve`,
    );
    expect(approved).toMatchObject({ trendable: true, requires_review: false });
    const linksApproved = await ok(z.array(ApiTrendsLink), "GET", "/api/v1/trends/links?limit=20");
    expect(linksApproved.map((link) => link.url)).toContain("https://publisher.example/story");

    // `PreviewCardProvider.find` reads the id as `String#to_i`.
    expect((await call("POST", `${PUBLISHERS}/${listed.id}abc/approve`)).status).toBe(200);
    expect((await call("POST", `${PUBLISHERS}/publisher.example/approve`)).status).toBe(404);
    expect((await call("POST", `${PUBLISHERS}/999999/reject`)).status).toBe(404);
    expect((await call("POST", `${PUBLISHERS}/${listed.id}/approve`, MEMBER)).status).toBe(403);
  });

  it("pages providers newest first by max_id, with a Link", async () => {
    await insertProviders(["page-a.example", "page-b.example", "page-c.example"]);
    const all = (await providers()).filter((provider) => provider.domain.startsWith("page-"));
    expect(all.map((provider) => provider.domain)).toEqual([
      "page-c.example",
      "page-b.example",
      "page-a.example",
    ]);
    const [c, b, a] = all.map((provider) => provider.id);

    const first = await call("GET", `${PUBLISHERS}?limit=2&max_id=${(c ?? 0) + 1}`);
    const firstPage = expectContract(z.array(ApiAdminPreviewCardProvider), await first.json());
    expect(firstPage.map((provider) => provider.id)).toEqual([c, b]);
    // A full page offers the next one (`records_continue?`); `limit` alone is kept.
    expect(first.headers.get("Link")).toBe(
      `<https://example.com${PUBLISHERS}?limit=2&max_id=${b}>; rel="next", ` +
        `<https://example.com${PUBLISHERS}?limit=2&min_id=${c}>; rel="prev"`,
    );

    const next = await call("GET", `${PUBLISHERS}?limit=2&max_id=${b}`);
    const nextPage = expectContract(z.array(ApiAdminPreviewCardProvider), await next.json());
    expect(nextPage.map((provider) => provider.id)).toContain(a);

    // `min_id` reads from the oldest side and answers newest first.
    const since = await providers(`?limit=2&min_id=${a}`);
    expect(since.map((provider) => provider.id)).toEqual([c, b]);
    const sinceId = await providers(`?since_id=${a}`);
    expect(sinceId.map((provider) => provider.id).slice(-2)).toEqual([c, b]);

    // An empty page sends no `Link`.
    const empty = await call("GET", `${PUBLISHERS}?max_id=0`);
    expect(await empty.json()).toEqual([]);
    expect(empty.headers.get("Link")).toBeNull();
  });

  // `PreviewCardProvider.matching_domain`: a link's provider is the row of
  // the longest of its host and the host's parent domains that has one.
  it("applies a provider's review to the subdomains that have no row of their own", async () => {
    await insertProviders(["parent.example", "own.parent.example"]);
    const parent = (await providers()).find((provider) => provider.domain === "parent.example");
    await ok(ApiAdminPreviewCardProvider, "POST", `${PUBLISHERS}/${parent?.id}/reject`);
    const links = [
      "https://news.parent.example/a",
      "https://deep.news.parent.example/b",
      "https://own.parent.example/c",
      "https://notparent.example/d",
    ];
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(MEMBER)) },
      body: JSON.stringify({ status: `links ${links.join(" ")}` }),
    });
    const status = expectContract(ApiStatus, await posted.json());
    await ok(ApiStatus, "POST", `/api/v1/statuses/${status.id}/favourite`);

    const expectParentRejection = async (): Promise<void> => {
      const trending = (
        await ok(z.array(ApiTrendsLink), "GET", "/api/v1/trends/links?limit=20")
      ).map((link) => link.url);
      const timeline = async (url: string): Promise<number> =>
        (await call("GET", `/api/v1/timelines/link?url=${encodeURIComponent(url)}`)).status;
      expect(trending).not.toContain("https://news.parent.example/a");
      expect(trending).not.toContain("https://deep.news.parent.example/b");
      expect(trending).toContain("https://own.parent.example/c");
      expect(trending).toContain("https://notparent.example/d");
      expect(await timeline("https://news.parent.example/a")).toBe(404);
      expect(await timeline("https://deep.news.parent.example/b")).toBe(404);
      expect(await timeline("https://own.parent.example/c")).toBe(200);
      expect(await timeline("https://notparent.example/d")).toBe(200);
    };
    await expectParentRejection();

    // `request_review` writes a row only for a host no provider matches, so
    // the subdomains stay under the parent's review.
    await fireSixHourlyCron();
    const domains = (await providers()).map((provider) => provider.domain);
    expect(domains).not.toContain("news.parent.example");
    expect(domains).not.toContain("deep.news.parent.example");
    expect(domains).toContain("notparent.example");
    await expectParentRejection();
  });

  it("seeks each candidate domain on the unique domain index", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${PREVIEW_CARD_PROVIDERS_BY_DOMAIN_SQL}`,
    )
      .bind(JSON.stringify(["news.parent.example", "parent.example", "example"]))
      .all();
    const plan = z
      .array(z.object({ detail: z.string() }))
      .parse(results)
      .map((row) => row.detail);
    expect(plan).toContainEqual(
      "SEARCH preview_card_providers USING INDEX sqlite_autoindex_preview_card_providers_1 (domain=?)",
    );
    expect(plan.filter((detail) => detail.startsWith("SCAN preview_card_providers"))).toEqual([]);
  });
});
