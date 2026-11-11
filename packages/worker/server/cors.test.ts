import { describe, expect, it } from "vite-plus/test";
import { Hono } from "hono";
import { apiCors, isApiCorsPath, resolveApiCorsOrigin } from "./cors";
import { envWith } from "../test/env-fixture";

const env = envWith({
  INSTANCE_DOMAIN: "example.com",
  INSTANCE_PUBLIC_ORIGIN: "https://example.com",
  INSTANCE_NAME: "tstodon",
  INSTANCE_DESCRIPTION: "test",
  SOURCE_URL: "https://github.com/example/tstodon",
  INSTANCE_LANGUAGES: "en",
  CONTACT_EMAIL: "admin@example.com",
  INSTANCE_THUMBNAIL_URL: "https://example.com/site/thumbnail.png",
  MEDIA_PUBLIC_BASE_URL: "https://example.com",
  CORS_ALLOWED_ORIGINS: "https://web.example.com, https://admin.example.com/",
});

describe("cors allowlist", () => {
  it("allows the instance public origin and configured extras", () => {
    expect(resolveApiCorsOrigin(env, "https://example.com")).toBe("https://example.com");
    expect(resolveApiCorsOrigin(env, "https://web.example.com")).toBe("https://web.example.com");
    expect(resolveApiCorsOrigin(env, "https://admin.example.com")).toBe(
      "https://admin.example.com",
    );
    expect(resolveApiCorsOrigin(env, "https://admin.example.com/")).toBe(
      "https://admin.example.com",
    );
    expect(resolveApiCorsOrigin(env, "https://evil.example")).toBeUndefined();
    expect(resolveApiCorsOrigin(env, "")).toBeUndefined();
  });
});

describe("api cors headers", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", apiCors());
  app.get("/api/v1/statuses", (c) => c.text("ok"));

  it("allows Idempotency-Key on preflight", async () => {
    const response = await app.request(
      "/api/v1/statuses",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "idempotency-key",
        },
      },
      env,
    );
    expect(response.headers.get("access-control-allow-headers") ?? "").toMatch(/idempotency-key/i);
  });

  it("exposes Link and the rate-limit headers", async () => {
    const response = await app.request(
      "/api/v1/statuses",
      { headers: { Origin: "https://example.com" } },
      env,
    );
    const exposed = (response.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const name of [
      "link",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ]) {
      expect(exposed).toContain(name);
    }
  });
});

describe("isApiCorsPath", () => {
  it("covers the API, OAuth token endpoints and discovery documents", () => {
    for (const path of [
      "/api/v1/instance",
      "/oauth/token",
      "/oauth/revoke",
      "/.well-known/webfinger",
      "/.well-known/nodeinfo",
      "/nodeinfo/2.0",
    ]) {
      expect(isApiCorsPath(path), path).toBe(true);
    }
    for (const path of ["/oauth/authorize", "/apix", "/nodeinfox", "/media/a"]) {
      expect(isApiCorsPath(path), path).toBe(false);
    }
  });
});
