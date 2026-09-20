import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker http", () => {
  it("serves healthz", async () => {
    const response = await SELF.fetch("https://example.com/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "Ok",
      service: "tstodon",
    });
  });

  it("serves Mastodon instance metadata", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/instance");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: "MastodonInstance",
      uri: "example.com",
      title: "tstodon",
    });
  });
});
