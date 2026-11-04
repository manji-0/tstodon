import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ORIGIN } from "../test/passkey-browser";

/** Whether `pnpm web:build` has put the Mastodon UI, and its helper pack, into the assets under test. */
const webBuilt = (await SELF.fetch(`${ORIGIN}/packs/tstodon-web.json`)).ok;

describe("remote interaction helper", () => {
  it.skipIf(!webBuilt)("serves Mastodon's helper page, framed by this origin only", async () => {
    const response = await SELF.fetch(`${ORIGIN}/remote_interaction_helper`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("public");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).toContain("connect-src https:");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-inline");

    const html = await response.text();
    expect(html).toContain('<meta name="robots" content="noindex">');
    const script = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
    expect(script).toMatch(/^\/packs\/.+\.js$/);
    const pack = await SELF.fetch(`${ORIGIN}${script}`);
    expect(pack.status).toBe(200);
    expect(await pack.text()).toContain("fetchInteractionURL");
  });

  it.skipIf(webBuilt)("is not served without a web build", async () => {
    expect((await SELF.fetch(`${ORIGIN}/remote_interaction_helper`)).status).toBe(404);
  });
});
