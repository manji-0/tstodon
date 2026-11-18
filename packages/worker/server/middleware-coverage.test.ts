import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";

/**
 * Request-wide middleware (`app/middleware/*`) runs for every path, whatever
 * route it matches or misses. Hono before 4.13.16 could skip wildcard
 * middleware for some route sets and for paths with an encoded line
 * terminator, so an `ip_blocks` range must refuse such paths too.
 */
describe("request-wide middleware", () => {
  it.each([
    "/api/v1/instance%0A",
    "/api/v1/instance%0D",
    "/api/v1/instance%E2%80%A8",
    "/api/v1/accounts/1%0A/statuses",
    "/users/alice%0A",
    "/inbox%0A",
  ])("refuses a no_access address on %s", async (path) => {
    const created = await SELF.fetch("https://example.com/api/v1/admin/ip_blocks", {
      method: "POST",
      headers: {
        ...(await authHeaders("middleware-coverage-admin@example.com", { admin: true })),
        "content-type": "application/json",
      },
      body: JSON.stringify({ ip: "198.51.100.0/28", severity: "no_access" }),
    });
    expect([200, 422]).toContain(created.status);
    const response = await SELF.fetch(`https://example.com${path}`, {
      headers: { "CF-Connecting-IP": "198.51.100.7" },
    });
    expect(response.status).toBe(403);
  });
});
