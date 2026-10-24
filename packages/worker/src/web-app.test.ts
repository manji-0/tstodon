import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";
import { StreamEvent } from "@tstodon/domain";
import { publishToAccount } from "./stream-publish";
import { ORIGIN, read, signUp } from "../test/passkey-browser";
import { isWebAppPath, webAppPage, type WebManifest } from "./web-app";

const MANIFEST: WebManifest = {
  ref: "test",
  polyfills: "/packs/polyfills.js",
  themeSelection: "/packs/theme-selection.js",
  inert: "/packs/inert.css",
  theme: "/packs/theme.css",
  common: { js: "/packs/common.js", css: [], preload: [] },
  application: { js: "/packs/application.js", css: ["/packs/app.css"], preload: ["/packs/r.js"] },
  locales: ["en", "ja"],
};

/** Whether `pnpm web:build` has put the Mastodon UI into the assets under test. */
const webBuilt = (await SELF.fetch(`${ORIGIN}/packs/tstodon-web.json`)).ok;

const InitialStateSchema = z.object({
  meta: z.object({
    access_token: z.string().nullable(),
    me: z.string().optional(),
    locale: z.string(),
    title: z.string(),
  }),
  accounts: z.record(z.string(), z.object({ username: z.string() })),
  compose: z.object({ default_privacy: z.string().optional() }),
  settings: z.unknown(),
});

const initialState = (html: string) =>
  read(
    InitialStateSchema,
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

  it("renders the shell with the initial state that cannot break out of its script", () => {
    const html = webAppPage(MANIFEST, {
      locale: "ja",
      title: "tstodon",
      path: "/home",
      signedIn: true,
      vapidKey: null,
      state: { meta: { title: "</script><script>alert(1)</script>" } },
    });
    expect(html).toContain('<html lang="ja"');
    expect(html).toContain('<script type="module" src="/packs/application.js"');
    expect(html).toContain('<link rel="modulepreload" href="/packs/r.js"');
    expect(html).toContain('<meta name="initialPath" content="/home">');
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
    expect(await out.json()).toEqual({ redirect_to: "/" });
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
    await publishToAccount(env, account.id, event.value);
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

  it.skipIf(!webBuilt)(
    "boots signed out and signed in, with a token tied to the session",
    async () => {
      const anonymous = await SELF.fetch(`${ORIGIN}/`, {
        headers: { "Accept-Language": "ja,en;q=0.5" },
      });
      expect(anonymous.status).toBe(200);
      expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
      const signedOut = initialState(await anonymous.text());
      expect(signedOut.meta.access_token).toBeNull();
      expect(signedOut.meta.locale).toBe("ja");

      const { fetcher } = await signUp("web_viewer");
      const page = await fetcher("/home");
      expect(page.status).toBe(200);
      const state = initialState(await page.text());
      const token = state.meta.access_token ?? "";
      expect(token.length).toBeGreaterThan(20);
      expect(state.accounts[state.meta.me ?? ""]?.username).toBe("web_viewer");
      expect(state.compose.default_privacy).toBe("public");

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
    },
  );
});
