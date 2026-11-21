import { describe, expect, it } from "vite-plus/test";
import { Hono } from "hono";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  limitParam,
  PageSize,
  rackQueryParam,
  rubyToI,
} from "./http";
import { z } from "zod";

const KindBody = z.object({ kind: z.string() });

describe("rubyToI", () => {
  // Each pair is what Ruby 3's `String#to_i` returns for the string.
  it.each([
    ["5abc", 5],
    [" 5", 5],
    ["\t\n\v\f\r5", 5],
    [" 5", 0],
    ["+5", 5],
    ["-5", -5],
    ["1_000", 1000],
    ["1__0", 1],
    ["_1", 0],
    ["1_", 1],
    ["0x10", 0],
    ["1e3", 1],
    ["5.9", 5],
    ["05", 5],
    ["abc", 0],
    ["", 0],
    ["-", 0],
    ["- 5", 0],
    ["+-5", 0],
  ])("reads %j as %d", (raw, expected) => {
    expect(rubyToI(raw)).toBe(expected);
  });
});

describe("limitParam", () => {
  it("takes the default only when limit is absent", () => {
    expect(limitParam(undefined, PageSize.statuses)).toBe(20);
    expect(limitParam("", PageSize.statuses)).toBe(0);
    expect(limitParam("0", PageSize.statuses)).toBe(0);
    expect(limitParam("abc", PageSize.statuses)).toBe(0);
  });

  it("reads a negative limit by its absolute value", () => {
    expect(limitParam("-3", PageSize.statuses)).toBe(3);
    expect(limitParam("-500", PageSize.statuses)).toBe(40);
  });

  it("caps at the page size's max", () => {
    expect(limitParam("40", PageSize.statuses)).toBe(40);
    expect(limitParam("41", PageSize.statuses)).toBe(40);
    expect(limitParam("99999999999999999999999", PageSize.accounts)).toBe(80);
  });

  it("matches Mastodon v4.7.5's controller constants", () => {
    expect(PageSize).toEqual({
      statuses: { default: 20, max: 40 },
      accounts: { default: 40, max: 80 },
      trends: { default: 10, max: 20 },
      domainBlocks: { default: 100, max: 200 },
      unreadNotifications: { default: 100, max: 1000 },
      admin: { default: 100, max: 200 },
      adminDomainRules: { default: 100, max: 500 },
    });
  });
});

describe("rackQueryParam", () => {
  const read = (query: string) =>
    rackQueryParam(`https://example.com/api/v1/blocks${query}`, "limit");

  it("reads a key with no = as absent, as Rack's nil", () => {
    expect(read("")).toBeUndefined();
    expect(read("?limit")).toBeUndefined();
    expect(read("?foo=1&limit")).toBeUndefined();
    expect(read("?limit=")).toBe("");
  });

  it("takes the first value of a repeated key, decoded", () => {
    expect(read("?limit=1&limit=2")).toBe("1");
    expect(read("?limit&limit=2")).toBeUndefined();
    expect(read("?%6Cimit=%2B5")).toBe("+5");
    expect(read("?limit=+5")).toBe(" 5");
    expect(read("?limits=5&xlimit=6")).toBeUndefined();
  });
});

describe("Result to HTTP mappers", () => {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/auth/:kind", (c) => {
    const kind = c.req.param("kind");
    if (kind === "MissingToken") {
      return jsonAuthError(c, { kind: "MissingToken" });
    }
    if (kind === "InvalidToken") {
      return jsonAuthError(c, { kind: "InvalidToken" });
    }
    if (kind === "Forbidden") {
      return jsonAuthError(c, { kind: "Forbidden" });
    }
    if (kind === "VerificationUnavailable") {
      return jsonAuthError(c, { kind: "VerificationUnavailable" });
    }
    return jsonAuthError(c, { kind: "RepositoryError", message: "db down" });
  });
  app.get("/validation", (c) => jsonValidationError(c));
  app.get("/repo", (c) => jsonRepositoryError(c, "boom"));

  it("maps MissingToken and InvalidToken to 401", async () => {
    for (const kind of ["MissingToken", "InvalidToken"] as const) {
      const res = await app.request(`/auth/${kind}`);
      expect(res.status).toBe(401);
      const body = KindBody.parse(await res.json());
      expect(body.kind).toBe(kind);
    }
  });

  it("maps Forbidden to 403", async () => {
    const res = await app.request("/auth/Forbidden");
    expect(res.status).toBe(403);
    const body = KindBody.parse(await res.json());
    expect(body.kind).toBe("Forbidden");
  });

  it("maps VerificationUnavailable to 503 with Retry-After", async () => {
    const res = await app.request("/auth/VerificationUnavailable");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = KindBody.parse(await res.json());
    expect(body.kind).toBe("VerificationUnavailable");
  });

  it("maps RepositoryError to 500", async () => {
    const res = await app.request("/auth/RepositoryError");
    expect(res.status).toBe(500);
    const body = z.object({ kind: z.string(), error: z.string() }).parse(await res.json());
    expect(body.kind).toBe("RepositoryError");
    expect(body.error).toBe("db down");
  });

  it("maps validation and repository helpers", async () => {
    const validation = await app.request("/validation");
    expect(validation.status).toBe(400);
    expect(await validation.json()).toEqual({
      error: "ValidationError",
      kind: "ValidationError",
    });
    const repo = await app.request("/repo");
    expect(repo.status).toBe(500);
    expect(await repo.json()).toEqual({ error: "boom", kind: "RepositoryError" });
  });
});
