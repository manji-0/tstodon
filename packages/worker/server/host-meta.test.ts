import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

describe("host-meta", () => {
  it("serves the XRD with the WebFinger LRDD template", async () => {
    const response = await SELF.fetch("https://example.com/.well-known/host-meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xrd+xml; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = await response.text();
    expect(body).toContain('<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">');
    expect(body).toContain(
      '<Link rel="lrdd" template="https://example.com/.well-known/webfinger?resource={uri}"/>',
    );
  });

  it("serves the same link as a JRD", async () => {
    const response = await SELF.fetch("https://example.com/.well-known/host-meta.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/jrd+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      links: [
        { rel: "lrdd", template: "https://example.com/.well-known/webfinger?resource={uri}" },
      ],
    });
  });

  it("answers HEAD without a body", async () => {
    const response = await SELF.fetch("https://example.com/.well-known/host-meta", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
