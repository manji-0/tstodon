import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { jsonAuthError, jsonRepositoryError, jsonValidationError, queryLimit } from "./http";

describe("queryLimit", () => {
  it("falls back when missing or non-positive", () => {
    expect(queryLimit(undefined)).toBe(20);
    expect(queryLimit("")).toBe(20);
    expect(queryLimit("0")).toBe(20);
    expect(queryLimit("-3", 10)).toBe(10);
    expect(queryLimit("abc", 7)).toBe(7);
  });

  it("clamps to 40", () => {
    expect(queryLimit("1")).toBe(1);
    expect(queryLimit("40")).toBe(40);
    expect(queryLimit("100")).toBe(40);
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
      const body = (await res.json()) as { kind: string };
      expect(body.kind).toBe(kind);
    }
  });

  it("maps Forbidden to 403", async () => {
    const res = await app.request("/auth/Forbidden");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("Forbidden");
  });

  it("maps VerificationUnavailable to 503 with Retry-After", async () => {
    const res = await app.request("/auth/VerificationUnavailable");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("VerificationUnavailable");
  });

  it("maps RepositoryError to 500", async () => {
    const res = await app.request("/auth/RepositoryError");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { kind: string; error: string };
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
