import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiAccount } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";

const get = (path: string, headers: Record<string, string>) =>
  SELF.fetch(`https://example.com${path}`, { headers });

const accountId = async (email: string): Promise<string> =>
  expectContract(
    ApiAccount,
    await (await get("/api/v1/accounts/verify_credentials", await authHeaders(email))).json(),
  ).id;

const linkQueries = (link: string | null): string[] =>
  [...(link ?? "").matchAll(/<([^>]+)>/g)].map((match) => new URL(match[1] ?? "").search);

/** The query a `Link` keeps, as Mastodon v4.7.5's `Api::Pagination#pagination_params`. */
describe("Link header params", () => {
  it("keeps only limit on a list that permits no filters", async () => {
    const email = "link-params-blocker@example.com";
    const headers = await authHeaders(email);
    for (const other of ["link-params-a@example.com", "link-params-b@example.com"]) {
      const blocked = await SELF.fetch(
        `https://example.com/api/v1/accounts/${await accountId(other)}/block`,
        { method: "POST", headers },
      );
      expect(blocked.status).toBe(200);
    }
    const response = await get("/api/v1/blocks?limit=1&foo=bar&offset=3&since_id=1", headers);
    expect(response.status).toBe(200);
    const queries = linkQueries(response.headers.get("Link"));
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      const params = new URLSearchParams(query);
      expect(params.get("limit")).toBe("1");
      expect([...params.keys()].toSorted()).toEqual(
        params.has("max_id") ? ["limit", "max_id"] : ["limit", "min_id"],
      );
    }
  });

  it("keeps the filters a notification list permits", async () => {
    const email = "link-params-notified@example.com";
    const headers = await authHeaders(email);
    const follower = await authHeaders("link-params-follower@example.com");
    const followed = await SELF.fetch(
      `https://example.com/api/v1/accounts/${await accountId(email)}/follow`,
      { method: "POST", headers: follower },
    );
    expect(followed.status).toBe(200);
    const response = await get(
      "/api/v1/notifications?limit=1&types[]=follow&exclude_types[]=mention&foo=bar",
      headers,
    );
    expect(response.status).toBe(200);
    const [next] = linkQueries(response.headers.get("Link"));
    const params = new URLSearchParams(next);
    expect(params.getAll("types[]")).toEqual(["follow"]);
    expect(params.getAll("exclude_types[]")).toEqual(["mention"]);
    expect(params.get("limit")).toBe("1");
    expect(params.has("foo")).toBe(false);
  });
});
