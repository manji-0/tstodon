import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { EMBED_CODE_STYLES } from "./status-embed";

const ORIGIN = "https://example.com";

const get = (path: string, init?: RequestInit) => SELF.fetch(`${ORIGIN}${path}`, init);

/** The directives of a `Content-Security-Policy` header, by name. */
const directives = (header: string | null): Map<string, ReadonlyArray<string>> =>
  new Map(
    (header ?? "")
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name !== undefined && name.length > 0)
      .map(([name, ...values]) => [name ?? "", values]),
  );

const expectLockedDown = (response: Response) => {
  const csp = directives(response.headers.get("content-security-policy"));
  expect(csp.get("default-src")).toEqual(["'none'"]);
  expect(csp.get("base-uri")).toEqual(["'none'"]);
  expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
  expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
  expect(csp.get("script-src")).not.toContain("'unsafe-eval'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return csp;
};

/** `<script>` elements with code in them, other than JSON data blocks. */
const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes = "", body = ""]) => {
      const isData = /type="application\/json"/.test(attributes);
      return !isData && !/\bsrc=/.test(attributes) && body.trim().length > 0;
    })
    .map(([element]) => element);

describe("security headers", () => {
  it("send Mastodon's content security policy with the web app shell", async () => {
    const response = await get("/home", {
      headers: await authHeaders("security-headers-shell@example.com"),
    });
    expect(response.status).toBe(200);
    const csp = expectLockedDown(response);
    expect(csp.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(csp.get("connect-src")).toContain("wss://example.com");
    expect(csp.get("img-src")).toContain("https:");
    expect(csp.get("media-src")).toContain("https:");
    const html = await response.text();
    // The style nonce the web app hands to the styles it inserts (react-select).
    const nonce = /<meta name="style-nonce" content="([^"]+)">/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp.get("style-src")).toContain(`'nonce-${nonce}'`);
    // The embed code's styles, which the "Get embed code" preview renders.
    expect(csp.get("style-src")).toContain("'unsafe-hashes'");
    for (const style of EMBED_CODE_STYLES) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
      const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
      expect(csp.get("style-src")).toContain(`'sha256-${hash}'`);
    }
    expect(inlineScripts(html)).toEqual([]);
  });

  it("use a fresh style nonce for each page", async () => {
    const headers = await authHeaders("security-headers-nonce@example.com");
    const [first, second] = await Promise.all([get("/home", { headers }), get("/home", { headers })]);
    expect(first?.headers.get("content-security-policy")).not.toBe(
      second?.headers.get("content-security-policy"),
    );
  });

  it("lock down the pages the Worker renders, with no inline script", async () => {
    const response = await get("/auth/sign_in", {
      headers: await authHeaders("security-headers-sign-in@example.com"),
    });
    expect(response.status).toBe(200);
    expectLockedDown(response);
    expect(inlineScripts(await response.text())).toEqual([]);
  });

  it("let any site frame a status's embed page", async () => {
    const author = await signedInAccount("security-headers-embed@example.com");
    const created = await get("/api/v1/statuses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("security-headers-embed@example.com")),
      },
      body: JSON.stringify({ status: "embed me", visibility: "public" }),
    });
    const id = expectContract(ApiStatus, await created.json()).id;
    const response = await get(`/@${author.username}/${id}/embed`);
    expect(response.status).toBe(200);
    const csp = directives(response.headers.get("content-security-policy"));
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.has("frame-ancestors")).toBe(false);
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("mark API answers nosniff and same-origin", async () => {
    const response = await get("/api/v1/instance");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("put no document policy on a script, which would bind the service worker", async () => {
    // A worker runs under its script's policy: this one's `connect-src` would
    // stop the service worker fetching remote avatars and media.
    const response = await get("/sw.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
