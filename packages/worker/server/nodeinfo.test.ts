import { NodeInfo20, NodeInfo21, NodeInfoDiscovery } from "@tstodon/api/activitypub";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { expectContract } from "../test/api-contract";
import { signedInAccount } from "../test/auth-fixture";
import { z } from "zod";
import { countAccounts } from "./account-store";
import { countActiveAccounts, recordAccountActivity } from "./account-activity";

const fetchJson = async (path: string): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`);
  expect(response.status).toBe(200);
  return response.json();
};

const DAY_MS = 86_400_000;

describe("active accounts", () => {
  it("counts accounts with an authenticated request inside each window", async () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const recent = await signedInAccount("nodeinfo-recent@example.com");
    const older = await signedInAccount("nodeinfo-older@example.com");
    await signedInAccount("nodeinfo-idle@example.com");
    const request = new Request("https://example.com/api/v1/accounts/verify_credentials");
    await recordAccountActivity(env.DB, recent.id, request, new Date(now.getTime() - 29 * DAY_MS));
    await recordAccountActivity(env.DB, older.id, request, new Date(now.getTime() - 100 * DAY_MS));

    expect((await countActiveAccounts(env.DB, 30, now))._unsafeUnwrap()).toBe(1);
    expect((await countActiveAccounts(env.DB, 180, now))._unsafeUnwrap()).toBe(2);
    expect((await countActiveAccounts(env.DB, 28, now))._unsafeUnwrap()).toBe(0);
  });
});

describe("nodeinfo", () => {
  it("links both schema versions", async () => {
    const discovery = expectContract(NodeInfoDiscovery, await fetchJson("/.well-known/nodeinfo"));
    expect(discovery.links).toEqual([
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
        href: "https://example.com/nodeinfo/2.0",
      },
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
        href: "https://example.com/nodeinfo/2.1",
      },
    ]);
  });

  it("serves 2.1 with user counts, local posts and the repository", async () => {
    const nodeinfo = expectContract(NodeInfo21, await fetchJson("/nodeinfo/2.1"));
    expect(nodeinfo.software).toMatchObject({
      name: "tstodon",
      repository: "https://github.com/YOUR_ORG/tstodon",
    });
    expect(nodeinfo.usage.users.total).toBe(3);
    expect(nodeinfo.usage.users.activeHalfyear).toBeGreaterThanOrEqual(0);
    expect(nodeinfo.usage.users.activeMonth).toBeGreaterThanOrEqual(0);
    expect(nodeinfo.usage.localPosts).toBe(0);
    expect(nodeinfo.metadata).toMatchObject({ nodeName: expect.any(String) });
  });

  it("serves 2.0 with the same usage and caches the document", async () => {
    const before = expectContract(NodeInfo20, await fetchJson("/nodeinfo/2.0"));
    expect(before.usage.users.total).toBe(3);
    await signedInAccount("nodeinfo-late@example.com");
    const response = await SELF.fetch("https://example.com/nodeinfo/2.0");
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    const after = expectContract(NodeInfo20, await response.json());
    expect(after.usage.users.total).toBe(3);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("v2 instance usage", () => {
  it("reports accounts active in the last 30 days, not every account", async () => {
    const stale = await signedInAccount("v2-usage-stale@example.com");
    await signedInAccount("v2-usage-idle@example.com");
    const request = new Request("https://example.com/api/v1/accounts/verify_credentials");
    await recordAccountActivity(env.DB, stale.id, request, new Date(Date.now() - 100 * DAY_MS));

    const document = z
      .object({ usage: z.object({ users: z.object({ active_month: z.number() }) }) })
      .parse(await fetchJson("/api/v2/instance"));
    const active = (await countActiveAccounts(env.DB, 30))._unsafeUnwrap();
    const total = (await countAccounts(env.DB))._unsafeUnwrap();
    expect(document.usage.users.active_month).toBe(active);
    expect(active).toBeLessThan(total);
  });
});
