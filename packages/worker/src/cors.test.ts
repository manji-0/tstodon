import { describe, expect, it } from "vitest";
import { resolveApiCorsOrigin } from "./cors";

const env = {
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
} as unknown as Env;

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
