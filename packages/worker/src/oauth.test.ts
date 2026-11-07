import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { browser, ORIGIN, postForm, read, signUp, type Browser } from "../test/passkey-browser";
import { signAccessJwt } from "../test/access-jwt-fixture";
import { pkceS256 } from "./oauth-store";

const CALLBACK = "https://client.example/callback";

const registerApp = async (scopes = "read write follow push") => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [CALLBACK, "urn:ietf:wg:oauth:2.0:oob"],
      scopes,
      website: "https://client.example",
    }),
  });
  expect(response.status).toBe(200);
  return read(
    z.object({
      id: z.string(),
      name: z.literal("Test Client"),
      scopes: z.array(z.string()),
      redirect_uris: z.array(z.string()),
      client_id: z.string(),
      client_secret: z.string(),
      vapid_key: z.string(),
    }),
    await response.json(),
  );
};

type App = Awaited<ReturnType<typeof registerApp>>;

/** Consent as the signed-in `fetcher`; the code from the redirect. */
const authorize = async (
  fetcher: Browser,
  app: App,
  fields: Readonly<Record<string, string>> = {},
): Promise<string> => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: app.client_id,
    redirect_uri: CALLBACK,
    scope: "read write",
    state: "opaque-state",
    ...fields,
  });
  const consent = await fetcher(`/oauth/authorize?${query.toString()}`);
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Authorize Test Client?");
  const approved = await postForm(fetcher, "/oauth/authorize", {
    ...Object.fromEntries(query),
    decision: "approve",
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
  expect(location.searchParams.get("state")).toBe("opaque-state");
  return location.searchParams.get("code") ?? "";
};

const exchange = (app: App, fields: Readonly<Record<string, string>>) =>
  SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: CALLBACK,
      ...fields,
    }).toString(),
  });

const TokenSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  scope: z.string(),
  created_at: z.number(),
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const me = (token: string) =>
  SELF.fetch(`${ORIGIN}/api/v1/accounts/verify_credentials`, { headers: bearer(token) });

describe("Access sign-in and Mastodon OAuth", () => {
  it("signs in through Access and authorizes an app with PKCE", async () => {
    const { fetcher } = await signUp("passkey_alice");
    const app = await registerApp();
    const verifier = "a-code-verifier-that-is-long-enough-for-pkce-0123456789";
    const code = await authorize(fetcher, app, {
      code_challenge: await pkceS256(verifier),
      code_challenge_method: "S256",
    });

    // The wrong verifier burns the code.
    expect((await exchange(app, { code, code_verifier: "wrong" })).status).toBe(400);
    const retry = await authorize(fetcher, app, {
      code_challenge: await pkceS256(verifier),
      code_challenge_method: "S256",
    });
    const issued = await exchange(app, { code: retry, code_verifier: verifier });
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const token = read(TokenSchema, await issued.json());
    expect(token.scope).toBe("read write");

    const account = await me(token.access_token);
    expect(account.status).toBe(200);
    expect(read(z.object({ username: z.string() }), await account.json()).username).toBe(
      "passkey_alice",
    );
    // A code redeems once.
    const replay = await exchange(app, { code: retry, code_verifier: verifier });
    expect(replay.status).toBe(400);
    expect(read(z.object({ error: z.string() }), await replay.json()).error).toBe("invalid_grant");
  });

  it("signs back in with the same Access identity and does not open passkey registration", async () => {
    await signUp("passkey_bob");
    const again = browser(await signAccessJwt({ email: "passkey_bob@mail.example" }));
    const page = await again("/auth/sign_in");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("@passkey_bob");
    expect((await again("/api/auth/passkey/generate-authenticate-options")).status).not.toBe(200);
    const accounts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE username = ?`)
      .bind("passkey_bob")
      .first("n");
    expect(accounts).toBe(1);
  });

  it("provisions the account from the Access email, once", async () => {
    const fetcher = browser(await signAccessJwt({ email: "Hank@Mail.Example" }));
    const page = await fetcher("/auth/sign_in");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("@hank");
    const row = await env.DB.prepare(
      `SELECT u.email, u.emailVerified AS verified, a.access_email, a.username
       FROM accounts a JOIN "user" u ON u.id = a.auth_user_id WHERE a.access_email = ?`,
    )
      .bind("hank@mail.example")
      .first();
    expect(row).toEqual({
      email: "hank@mail.example",
      verified: 1,
      access_email: "hank@mail.example",
      username: "hank",
    });
    await fetcher("/auth/sign_in");
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE access_email = ?`)
      .bind("hank@mail.example")
      .first("n");
    expect(count).toBe(1);
    expect(await (await browser()("/auth/sign_in")).text()).not.toContain("@hank");
  });

  it("enforces scopes and revokes tokens", async () => {
    const { fetcher } = await signUp("passkey_dave");
    const app = await registerApp();
    const code = await authorize(fetcher, app, { scope: "read" });
    const token = read(TokenSchema, await (await exchange(app, { code })).json()).access_token;

    expect((await me(token)).status).toBe(200);
    const post = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ status: "read-only tokens cannot post" }),
    });
    expect(post.status).toBe(403);
    expect(read(z.object({ kind: z.string() }), await post.json()).kind).toBe("InsufficientScope");

    const revoked = await SELF.fetch(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, token }),
    });
    expect(revoked.status).toBe(200);
    expect((await me(token)).status).toBe(401);
  });

  it("refuses scopes beyond the app's registration", async () => {
    const { fetcher } = await signUp("passkey_erin");
    const app = await registerApp("read");
    const response = await fetcher(
      `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: CALLBACK, scope: "read write", state: "s" }).toString()}`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("state")).toBe("s");
  });

  it("shows the code for out-of-band apps and honours a denial", async () => {
    const { fetcher } = await signUp("passkey_frank");
    const app = await registerApp();
    const fields = {
      response_type: "code",
      client_id: app.client_id,
      redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
      scope: "read",
    };
    const shown = await postForm(fetcher, "/oauth/authorize", { ...fields, decision: "approve" });
    expect(shown.status).toBe(200);
    const code = /<code>([^<]+)<\/code>/.exec(await shown.text())?.[1] ?? "";
    const issued = await exchange(app, { code, redirect_uri: "urn:ietf:wg:oauth:2.0:oob" });
    expect(issued.status).toBe(200);

    const denied = await postForm(fetcher, "/oauth/authorize", {
      ...fields,
      redirect_uri: CALLBACK,
      decision: "deny",
    });
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("sends signed-out users to sign-in and never redirects to an unregistered URI", async () => {
    const app = await registerApp();
    const fetcher = browser();
    const signedOut = await fetcher(
      `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: CALLBACK }).toString()}`,
    );
    expect(signedOut.status).toBe(302);
    const location = signedOut.headers.get("location") ?? "";
    expect(location).toMatch(/^\/auth\/sign_in\?return_to=%2Foauth%2Fauthorize%3F/);

    const foreign = await fetcher(
      `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: "https://evil.example/" }).toString()}`,
    );
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
  });

  it("refuses a consent posted from another site", async () => {
    const { fetcher } = await signUp("passkey_grace");
    const app = await registerApp();
    const response = await fetcher("/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams({
        client_id: app.client_id,
        redirect_uri: CALLBACK,
        scope: "read",
        decision: "approve",
      }).toString(),
    });
    expect(response.status).toBe(403);
  });

  it("issues app-only tokens with client credentials", async () => {
    const app = await registerApp();
    const issued = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${app.client_id}:${app.client_secret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "read" }).toString(),
    });
    expect(issued.status).toBe(200);
    const token = read(TokenSchema, await issued.json()).access_token;

    const verified = await SELF.fetch(`${ORIGIN}/api/v1/apps/verify_credentials`, {
      headers: bearer(token),
    });
    expect(verified.status).toBe(200);
    expect(read(z.object({ name: z.string() }), await verified.json()).name).toBe("Test Client");
    // An app token acts for no user.
    expect((await me(token)).status).toBe(401);

    const badSecret = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: app.client_id,
        client_secret: "wrong",
      }),
    });
    expect(badSecret.status).toBe(401);
  });

  it("validates app registrations and publishes server metadata", async () => {
    const invalid = await SELF.fetch(`${ORIGIN}/api/v1/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Bad", redirect_uris: "not a uri" }),
    });
    expect(invalid.status).toBe(422);

    const metadata = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    expect(
      read(
        z.object({
          token_endpoint: z.string(),
          code_challenge_methods_supported: z.array(z.string()),
        }),
        await metadata.json(),
      ),
    ).toEqual({
      token_endpoint: "https://example.com/oauth/token",
      code_challenge_methods_supported: ["S256"],
    });
  });
});
