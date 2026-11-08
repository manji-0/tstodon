import { schemaResult } from "@tstodon/core";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, signedInAccount } from "../test/auth-fixture";
import { parseScopes, requiredScope, scopeAllows, scopesWithin } from "./oauth-scope";

const allows = (granted: string, method: string, path: string): boolean =>
  scopeAllows(granted.split(" "), requiredScope(method, path), path);

describe("granular OAuth scopes", () => {
  it("maps endpoints to Mastodon's granular scopes", () => {
    expect(requiredScope("GET", "/api/v1/timelines/home")).toEqual({
      kind: "Scope",
      scope: "read:statuses",
    });
    expect(requiredScope("POST", "/api/v1/statuses/123/favourite")).toEqual({
      kind: "Scope",
      scope: "write:favourites",
    });
    expect(requiredScope("POST", "/api/v1/accounts/abc/block")).toEqual({
      kind: "Scope",
      scope: "write:blocks",
    });
    expect(requiredScope("GET", "/api/v1/admin/reports/9")).toEqual({
      kind: "Scope",
      scope: "admin:read:reports",
    });
    expect(requiredScope("GET", "/api/v2/instance")).toEqual({ kind: "None" });
  });

  it("lets a top-level scope cover its granular ones, and not the reverse", () => {
    expect(allows("read", "GET", "/api/v1/notifications")).toBe(true);
    expect(allows("read:statuses", "GET", "/api/v1/timelines/home")).toBe(true);
    expect(allows("read:statuses", "GET", "/api/v1/notifications")).toBe(false);
    expect(allows("write:favourites", "POST", "/api/v1/statuses/1/favourite")).toBe(true);
    expect(allows("write:favourites", "POST", "/api/v1/statuses")).toBe(false);
    expect(allows("admin:read", "GET", "/api/v1/admin/accounts")).toBe(true);
    expect(allows("admin:read:reports", "GET", "/api/v1/admin/accounts")).toBe(false);
    // Suggestions take only the top-level scopes, as in Mastodon.
    expect(allows("read:accounts", "GET", "/api/v2/suggestions")).toBe(false);
  });

  it("treats `follow` and `profile` as Mastodon does", () => {
    expect(allows("follow", "POST", "/api/v1/accounts/a/follow")).toBe(true);
    expect(allows("follow", "GET", "/api/v1/blocks")).toBe(true);
    expect(allows("follow", "POST", "/api/v1/statuses")).toBe(false);
    expect(allows("profile", "GET", "/api/v1/accounts/verify_credentials")).toBe(true);
    expect(allows("profile", "GET", "/api/v1/accounts/abc")).toBe(false);
  });

  it("validates requested scopes against the app's registration", () => {
    expect(parseScopes("read:statuses write:media")).toEqual(["read:statuses", "write:media"]);
    expect(parseScopes("read:everything!")).toBeUndefined();
    expect(scopesWithin(["read:statuses"], ["read"])).toBe(true);
    expect(scopesWithin(["read"], ["read:statuses"])).toBe(false);
  });

  it("enforces a granular token at the API", async () => {
    const account = await signedInAccount("granular-scopes@example.com");
    const token = await accessTokenFor(account.id, ["read:statuses", "write:favourites"]);
    const call = (path: string, method = "GET", body?: unknown) =>
      SELF.fetch(`https://example.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    expect((await call("/api/v1/timelines/home")).status).toBe(200);
    const denied = await call("/api/v1/notifications");
    expect(denied.status).toBe(403);
    expect(
      schemaResult(z.object({ kind: z.string() }))(await denied.json())._unsafeUnwrap().kind,
    ).toBe("InsufficientScope");
    expect((await call("/api/v1/statuses", "POST", { status: "no write:statuses" })).status).toBe(
      403,
    );

    // Someone else's status, favourited with only `write:favourites`.
    const author = await signedInAccount("granular-scopes-author@example.com");
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessTokenFor(author.id)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "favourite me" }),
    });
    const statusId = schemaResult(z.object({ id: z.string() }))(await posted.json())._unsafeUnwrap()
      .id;
    expect((await call(`/api/v1/statuses/${statusId}/favourite`, "POST")).status).toBe(200);
  });
});
