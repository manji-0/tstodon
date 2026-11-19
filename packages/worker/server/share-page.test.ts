import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiInitialState } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { ORIGIN, signUp } from "../test/passkey-browser";

/**
 * `/share`, Mastodon's `SharesController`: the page the WebFinger FEP-3b86
 * `Create` template and `web+mastodon://share` links open, with the shared
 * text in the composer.
 */

const initialState = (html: string) =>
  expectContract(
    ApiInitialState,
    JSON.parse(
      /<script id="initial-state" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ??
        "null",
    ),
  );

describe("/share", () => {
  it("sends a signed-out browser to sign in, back to the share", async () => {
    const response = await SELF.fetch(`${ORIGIN}/share?text=hello`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/sign_in?return_to=${encodeURIComponent("/share?text=hello")}`,
    );
  });

  it("opens the composer with the title, text and URL to share", async () => {
    const { fetcher } = await signUp("share_page");
    const response = await fetcher(
      `/share?${new URLSearchParams({ title: "A title", text: "some <b>text</b>", url: "https://example.org/a" }).toString()}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self' 'nonce-");
    const html = await response.text();
    expect(html).toContain('id="mastodon-compose"');
    expect(html).toMatch(/<script type="module" src="[^"]*share[^"]*\.js"/);
    expect(html).toContain('class="modal-layout with-zig-zag-decoration compose-standalone"');
    const state = initialState(html);
    expect(state.compose.text).toBe("A title some <b>text</b> https://example.org/a");
    expect(state.meta.access_token).toEqual(expect.any(String));
  });
});
