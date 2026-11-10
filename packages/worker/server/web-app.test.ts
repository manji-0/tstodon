import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiInitialState, type ApiInitialStateJSON } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";
import { StreamEvent } from "@tstodon/domain";
import { publishToAccount } from "./stream-publish";
import { ORIGIN, read, signUp } from "../test/passkey-browser";
import {
  initialState as pageInitialState,
  isWebAppPath,
  packCacheControl,
  webAppPage,
  type WebManifest,
} from "./web-app";

const MANIFEST: WebManifest = {
  ref: "test",
  dev: false,
  polyfills: "/packs/polyfills.js",
  themeSelection: "/packs/theme-selection.js",
  inert: "/packs/inert.css",
  theme: "/packs/theme.css",
  pages: "/packs/pages.css",
  favicon: "/packs/favicon.png",
  common: { js: "/packs/common.js", css: [], preload: [] },
  application: { js: "/packs/application.js", css: ["/packs/app.css"], preload: ["/packs/r.js"] },
  remoteInteractionHelper: { js: "/packs/remote_interaction_helper.js", css: [], preload: [] },
  locales: ["en", "ja"],
};

/** The page's initial state, parsed with the contract the web UI reads it by. */
const initialState = (html: string) =>
  expectContract(
    ApiInitialState,
    JSON.parse(
      /<script id="initial-state" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ??
        "null",
    ),
  );

describe("Mastodon web app", () => {
  it("knows the web app's paths", () => {
    for (const path of [
      "/",
      "/home",
      "/@alice",
      "/@alice/123",
      "/@bob@remote.example",
      "/deck/home",
      "/explore/tags",
      "/notifications",
      "/tags/cats",
    ]) {
      expect(isWebAppPath(path)).toBe(true);
    }
    for (const path of [
      "/api/v1/instance",
      "/users/alice",
      "/auth/sign_in",
      "/packs/app.js",
      "/inbox",
    ]) {
      expect(isWebAppPath(path)).toBe(false);
    }
  });

  it("keeps the streaming URL on the host that served the page", async () => {
    expect(env.INSTANCE_PUBLIC_ORIGIN).toBe("https://example.com");
    const streamUrl = (state: ApiInitialStateJSON) =>
      expectContract(ApiInitialState, state).meta.streaming_api_base_url;

    const local = streamUrl(
      await pageInitialState(env, new Request("http://127.0.0.1:8787/home"), "en", undefined),
    );
    expect(local).toBe("ws://127.0.0.1:8787");
    expect(local).not.toBe("https://example.com");

    const proxied = streamUrl(
      await pageInitialState(
        env,
        new Request("http://a.tstodon.localhost/home", {
          headers: { "X-Forwarded-Proto": "https" },
        }),
        "en",
        undefined,
      ),
    );
    expect(proxied).toBe("wss://a.tstodon.localhost");
    expect(proxied).not.toBe("https://example.com");
    expect(proxied).not.toBe("wss://example.com");
  });

  it("renders the shell with the initial state that cannot break out of its script", () => {
    const html = webAppPage(MANIFEST, {
      locale: "ja",
      title: "tstodon",
      path: "/home",
      signedIn: true,
      vapidKey: null,
      state: { meta: { title: "</script><script>alert(1)</script>" } },
      appearance: { colorScheme: "auto", contrast: "auto" },
    });
    expect(html).toContain('<html lang="ja"');
    expect(html).toContain('<script type="module" src="/packs/application.js"');
    expect(html).toContain('<link rel="modulepreload" href="/packs/r.js"');
    expect(html).toContain('<meta name="initialPath" content="/home">');
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="/packs/favicon.png">',
    );
    expect(html).toContain("To use tstodon's web app");
    expect(html).not.toContain("</script><script>alert(1)");
  });

  it("redirects /web paths and sends ActivityPub clients from /@user to the actor", async () => {
    const web = await SELF.fetch(`${ORIGIN}/web/home`, { redirect: "manual" });
    expect(web.status).toBe(302);
    expect(web.headers.get("location")).toBe("/home");

    const actor = await SELF.fetch(`${ORIGIN}/@alice`, {
      headers: { Accept: "application/activity+json" },
      redirect: "manual",
    });
    expect(actor.status).toBe(301);
    expect(actor.headers.get("location")).toBe("/users/alice");
    const note = await SELF.fetch(`${ORIGIN}/@alice/123`, {
      headers: { Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' },
      redirect: "manual",
    });
    expect(note.headers.get("location")).toBe("/users/alice/statuses/123");
  });

  it("answers /favicon.ico with the build's favicon", async () => {
    const response = await SELF.fetch(`${ORIGIN}/favicon.ico`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const icon = await SELF.fetch(new URL(response.headers.get("location") ?? "", ORIGIN));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
  });

  it("lets browsers keep the content-hashed packs and revalidate the rest", () => {
    const immutable = "private, max-age=31536000, immutable";
    expect(packCacheControl("/packs/common-lwvm9nKJ.js")).toBe(immutable);
    expect(packCacheControl("/packs/ImmutablePropTypes-C_rOJ6cM.js")).toBe(immutable);
    expect(packCacheControl("/packs/assets/themes/default-Dk-Jc7j1.css")).toBe(immutable);
    expect(packCacheControl("/packs/sw.js")).toBeUndefined();
    expect(packCacheControl("/sw.js")).toBeUndefined();
    expect(packCacheControl("/emoji/1f600.svg")).toBeUndefined();
    expect(packCacheControl("/packsx/common-lwvm9nKJ.js")).toBeUndefined();
  });

  it("serves the shell's packs from the client build, cacheable, and the service worker revalidated", async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const urls = [
      ...html.matchAll(/<(?:script|link)[^>]* (?:src|href)="(\/packs\/[^"]+)"/g),
    ].flatMap((match) => (match[1] ? [match[1]] : []));
    // The theme, the inert styles, the polyfills, theme selection, common and application.
    expect(urls.length).toBeGreaterThan(5);
    expect(html).toMatch(/<script type="module" src="\/packs\/application-[\w-]{8}\.js"/);
    expect(html).not.toContain("/@vite/client");
    for (const url of urls) {
      const pack = await SELF.fetch(`${ORIGIN}${url}`);
      expect(pack.status, url).toBe(200);
      expect(pack.headers.get("cache-control"), url).toBe("private, max-age=31536000, immutable");
      await pack.body?.cancel();
    }
    const worker = await SELF.fetch(`${ORIGIN}/sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get("cache-control") ?? "").not.toContain("immutable");
    expect(await worker.text()).toContain("/packs/");
    // Upstream's emoji, fetched at build time, and the committed sounds.
    expect((await SELF.fetch(`${ORIGIN}/emoji/1f600.svg`)).status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/sounds/boop.mp3`)).status).toBe(200);
    // The fixed icon URLs the service worker puts on notifications.
    for (const icon of ["/badge.png", "/android-chrome-192x192.png"]) {
      const response = await SELF.fetch(`${ORIGIN}${icon}`);
      expect(response.status, icon).toBe(200);
      expect(response.headers.get("content-type"), icon).toBe("image/png");
      await response.body?.cancel();
    }
  });

  it("keeps the client build's Vite manifests out of the served assets", async () => {
    // The Worker build reads them from dist/client; `.assetsignore` keeps them
    // from being uploaded (public/.assetsignore, merged by the Cloudflare plugin).
    for (const path of ["/.vite/manifest.json", "/.vite/manifest-assets.json"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain("src/entrypoints/");
    }
  });

  it("stores the web UI's settings", async () => {
    const headers = await authHeaders("web-settings@example.com");
    const saved = await SELF.fetch(`${ORIGIN}/api/web/settings`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ data: { home: { shows: { reblog: false } } } }),
    });
    expect(saved.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT w.data_json FROM web_settings w JOIN accounts a ON a.id = w.account_id WHERE a.username = 'web_settings'",
    ).first<{ data_json: string }>();
    expect(JSON.parse(row?.data_json ?? "null")).toEqual({ home: { shows: { reblog: false } } });
    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/web/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: {} }),
        })
      ).status,
    ).toBe(401);
  });

  it("signs out of the Better Auth session", async () => {
    const { fetcher } = await signUp("web_signout");
    const out = await fetcher("/auth/sign_out", {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ redirect_to: "/cdn-cgi/access/logout" });
    const sessions = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM "session" s JOIN accounts a ON a.auth_user_id = s.userId WHERE a.username = 'web_signout'`,
    ).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });

  it("streams to a socket opened the way the web UI opens it", async () => {
    const account = await signedInAccount("web-stream@example.com");
    const token = await accessTokenFor(account.id);
    // A path with a trailing slash, and the token as the WebSocket subprotocol.
    const upgrade = await SELF.fetch(`${ORIGIN}/api/v1/streaming/`, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": token },
    });
    expect(upgrade.status).toBe(101);
    expect(upgrade.headers.get("Sec-WebSocket-Protocol")).toBe(token);
    const socket = upgrade.webSocket;
    if (!socket) {
      throw new Error("missing websocket");
    }
    socket.accept();
    socket.send(JSON.stringify({ type: "subscribe", stream: "user" }));
    const received = new Promise<string>((resolve) => {
      socket.addEventListener("message", (message) => {
        resolve(typeof message.data === "string" ? message.data : "");
      });
    });
    const event = StreamEvent.parse({ kind: "delete", statusId: "123" });
    if (event.isErr()) {
      throw new Error("stream event rejected");
    }
    // The hub takes the subscription some time after the socket sends it.
    let heard = false;
    void received.then(() => {
      heard = true;
    });
    for (let attempt = 0; attempt < 100 && !heard; attempt += 1) {
      await publishToAccount(env, account.id, event.value);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(JSON.parse(await received)).toEqual({
      stream: ["user"],
      event: "delete",
      payload: "123",
    });
    socket.close();

    // An upgrade nobody routes is a plain 404, never the static-asset fallback.
    const stray = await SELF.fetch(`${ORIGIN}/no-such-socket`, {
      headers: { Upgrade: "websocket" },
    });
    expect(stray.status).toBe(404);
  });

  it("accepts a post exactly as the web UI sends it", async () => {
    const posted = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
      method: "POST",
      headers: {
        ...(await authHeaders("web-compose@example.com")),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        status: "posted from the web UI #hello",
        spoiler_text: "",
        in_reply_to_id: null,
        media_ids: [],
        sensitive: false,
        visibility: "public",
        poll: null,
        language: "ja",
        quoted_status_id: null,
        quote_approval_policy: "public",
      }),
    });
    expect(posted.status).toBe(200);
  });

  it("serves and edits the profile document the web UI's profile pages use", async () => {
    const headers = await authHeaders("web-profile@example.com");
    const edited = await SELF.fetch(`${ORIGIN}/api/v1/profile`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Web Profile", note: "hello\nthere" }),
    });
    expect(edited.status).toBe(200);
    const profile = read(
      z.object({
        display_name: z.string(),
        note: z.string(),
        formatted_note: z.string(),
        featured_tags: z.array(z.unknown()),
        show_featured: z.boolean(),
      }),
      await (await SELF.fetch(`${ORIGIN}/api/v1/profile`, { headers })).json(),
    );
    expect(profile.display_name).toBe("Web Profile");
    expect(profile.note).toBe("hello\nthere");
    expect(profile.formatted_note).toContain("<br>");
  });

  it("boots signed out and signed in, with a token tied to the session", async () => {
    const anonymous = await SELF.fetch(`${ORIGIN}/`, {
      headers: { "Accept-Language": "ja,en;q=0.5" },
    });
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    const signedOut = initialState(await anonymous.text());
    expect(signedOut.meta.access_token).toBeNull();
    expect(signedOut.meta.locale).toBe("ja");
    expect(signedOut.meta.me).toBeUndefined();
    expect(signedOut.meta.admin).toBeNull();
    expect(signedOut.role).toBeUndefined();
    expect(signedOut.compose).toEqual({});

    const { fetcher } = await signUp("web_viewer");
    const page = await fetcher("/home");
    expect(page.status).toBe(200);
    const state = initialState(await page.text());
    const token = state.meta.access_token ?? "";
    expect(token.length).toBeGreaterThan(20);
    expect(state.accounts[state.meta.me ?? ""]?.username).toBe("web_viewer");
    expect(state.compose).toEqual({
      me: state.meta.me,
      default_privacy: "public",
      default_sensitive: false,
      default_language: "en",
      default_quote_policy: "public",
    });
    expect(state.role).toMatchObject({ id: "user", permissions: "0" });
    // `admin` is the site contact account (none here), not the viewer.
    expect(state.meta.admin).toBeNull();
    expect(state.meta.moved_to_account_id).toBeUndefined();

    // The same session keeps the same token; the token works on the API.
    expect(initialState(await (await fetcher("/home")).text()).meta.access_token).toBe(token);
    const me = await SELF.fetch(`${ORIGIN}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);

    // Signing out ends it.
    await fetcher("/auth/sign_out", {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const after = await SELF.fetch(`${ORIGIN}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  it("names the account a viewer moved to, with that account, as Mastodon's initial state", async () => {
    const target = await signedInAccount("web-move-target@example.com");
    const { fetcher } = await signUp("web_mover");
    const mover = await env.DB.prepare(
      "SELECT id FROM accounts WHERE username = 'web_mover'",
    ).first<{
      id: string;
    }>();
    await env.DB.prepare(
      "INSERT INTO account_moves (account_id, acct, target_uri, moved_at) VALUES (?, ?, ?, ?)",
    )
      .bind(
        mover?.id,
        target.username,
        `${ORIGIN}/users/${target.username}`,
        new Date().toISOString(),
      )
      .run();
    const state = initialState(await (await fetcher("/home")).text());
    expect(state.meta.me).toBe(mover?.id);
    expect(state.meta.moved_to_account_id).toBe(target.id);
    expect(state.accounts[target.id]?.username).toBe(target.username);
    expect(state.accounts[mover?.id ?? ""]?.moved?.id).toBe(target.id);
  });
});
