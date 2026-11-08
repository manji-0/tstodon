import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { envWith } from "../test/env-fixture";
import { browserFacingOrigin, isSameOriginPost, pageOrigin } from "./browser-session";

const portlessEnv = envWith({
  INSTANCE_DOMAIN: "a.tstodon.localhost",
  INSTANCE_PUBLIC_ORIGIN: "https://a.tstodon.localhost",
  INSTANCE_THUMBNAIL_URL: "https://a.tstodon.localhost/site/thumbnail.png",
  MEDIA_PUBLIC_BASE_URL: "https://a.tstodon.localhost",
});

const authorize = new Hono<{ Bindings: Env }>();
authorize.post("/oauth/authorize", (c) =>
  c.text(
    isSameOriginPost(c) ? "same" : "Authorization must be confirmed on this site.",
    isSameOriginPost(c) ? 200 : 403,
  ),
);

const postConsent = (url: string, headers: Record<string, string>) =>
  authorize.request(url, { method: "POST", headers }, portlessEnv);

describe("same-origin posts behind a TLS proxy", () => {
  it("accepts the https Origin a sign-up posts while request.url stays http", async () => {
    const response = await postConsent("http://a.tstodon.localhost/oauth/authorize", {
      origin: "https://a.tstodon.localhost",
    });
    expect(response.status).toBe(200);
  });

  it("accepts that Origin from X-Forwarded-Proto when the public origin is elsewhere", async () => {
    const response = await authorize.request(
      "http://a.tstodon.localhost/oauth/authorize",
      {
        method: "POST",
        headers: {
          origin: "https://a.tstodon.localhost",
          "x-forwarded-proto": "https",
        },
      },
      envWith({}),
    );
    expect(response.status).toBe(200);
    expect(browserFacingOrigin("http://a.tstodon.localhost/oauth/authorize", "https")).toBe(
      "https://a.tstodon.localhost",
    );
  });

  it("still refuses a post whose Origin is another site", async () => {
    const response = await postConsent("http://a.tstodon.localhost/oauth/authorize", {
      origin: "https://evil.example",
      "x-forwarded-proto": "https",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Authorization must be confirmed on this site.");
  });
});

describe("pageOrigin", () => {
  it("uses the configured public origin for browser URLs", () => {
    const request = new Request("http://a.tstodon.localhost/oauth/authorize");
    expect(pageOrigin(portlessEnv, request)).toBe("https://a.tstodon.localhost");
  });

  it("uses X-Forwarded-Proto when the instance origin does not parse", () => {
    const request = new Request(
      "http://a.tstodon.localhost/.well-known/oauth-authorization-server",
      {
        headers: { "X-Forwarded-Proto": "https, http" },
      },
    );
    expect(pageOrigin(envWith({ INSTANCE_DOMAIN: " " }), request)).toBe(
      "https://a.tstodon.localhost",
    );
  });
});
