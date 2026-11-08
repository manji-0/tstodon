import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

// The test pool runs `dist/ssr`, the Worker Void generates; these pin that down.
describe("Void worker entry", () => {
  it("answers Void's readiness probe", async () => {
    const response = await SELF.fetch("https://example.com/__void/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
  });

  it("serves the static index for the root path", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("keeps the JSON not-found body for unknown non-GET paths", async () => {
    const response = await SELF.fetch("https://example.com/does-not-exist", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ kind: "NotFound" });
  });
});
