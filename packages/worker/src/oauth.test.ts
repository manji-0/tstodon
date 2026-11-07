import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { browser, ORIGIN, postForm, read, signUp, type Browser } from "../test/passkey-browser";
import {
  accessAuthHeaders,
  LOCAL_ACCESS_ADMIN_GROUP,
  signAccessJwt,
} from "../test/access-jwt-fixture";
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

  const accountCount = (email: string) =>
    env.DB.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE access_email = ?`)
      .bind(email)
      .first("n");

  const userRole = (email: string) =>
    env.DB.prepare(`SELECT role FROM "user" WHERE email = ?`).bind(email).first("role");

  const accessVars = [
    "CF_ACCESS_ADMIN_GROUPS",
    "ADMIN_USERNAMES",
    "CF_ACCESS_TEAM_DOMAIN",
    "CF_ACCESS_JWKS_JSON",
  ] as const;

  const readAccessVar = (name: (typeof accessVars)[number]): string => {
    const value: unknown = Reflect.get(env, name);
    return typeof value === "string" ? value : "";
  };

  const withAccessEnv = async (
    patch: Readonly<Partial<Record<(typeof accessVars)[number], string>>>,
    body: () => Promise<void>,
  ) => {
    const previous = accessVars.map((name) => [name, readAccessVar(name)] as const);
    for (const name of accessVars) {
      const next = patch[name];
      if (next !== undefined) {
        Reflect.set(env, name, next);
      }
    }
    try {
      await body();
    } finally {
      for (const [name, value] of previous) {
        Reflect.set(env, name, value);
      }
    }
  };

  it("keeps the OAuth request across an Access force_login logout", async () => {
    const { fetcher } = await signUp("force_login_user");
    const app = await registerApp();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: app.client_id,
      redirect_uri: CALLBACK,
      scope: "read",
      state: "keep-me",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
      force_login: "true",
    });
    const response = await fetcher(`/oauth/authorize?${query.toString()}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "", "http://127.0.0.1");
    expect(location.pathname).toBe("/cdn-cgi/access/logout");
    const back = new URL(location.searchParams.get("redirect_url") ?? "");
    expect(back.pathname).toBe("/oauth/authorize");
    expect(back.searchParams.get("client_id")).toBe(app.client_id);
    expect(back.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe("keep-me");
    expect(back.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(back.searchParams.has("force_login")).toBe(false);
  });

  it("does not provision an account from an unrelated GET", async () => {
    const email = "side-effect@mail.example";
    const fetcher = browser(await signAccessJwt({ email }));
    const app = await registerApp();
    const authorize = await fetcher(
      `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: app.client_id, redirect_uri: CALLBACK }).toString()}`,
    );
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get("location")).toContain("/auth/sign_in");
    expect(await accountCount(email)).toBe(0);
    expect((await fetcher("/")).status).toBe(200);
    expect((await fetcher("/media/missing-attachment")).status).toBe(404);
    expect(await accountCount(email)).toBe(0);
    const signedIn = await fetcher("/auth/sign_in");
    expect(await signedIn.text()).toContain("@side_effect");
    expect(await accountCount(email)).toBe(1);
  });

  it("refuses the test Access key off a local host and ignores a non-RSA JWKS", async () => {
    const email = "off-local@mail.example";
    const token = await signAccessJwt({ email });
    const remote = await SELF.fetch(`${ORIGIN}/auth/sign_in`, {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(remote.status).toBe(200);
    expect(await remote.text()).not.toContain("@off_local");
    expect(await accountCount(email)).toBe(0);
    const local = await browser(token)("/auth/sign_in");
    expect(await local.text()).toContain("@off_local");

    await withAccessEnv(
      {
        CF_ACCESS_JWKS_JSON: JSON.stringify({
          keys: [{ kty: "EC", crv: "P-256", x: "AA", y: "BB", kid: "ec-key" }],
        }),
      },
      async () => {
        const page = await browser(await signAccessJwt({ email: "ec-only@mail.example" }))(
          "/auth/sign_in",
        );
        expect(await page.text()).not.toContain("@ec_only");
        expect(await accountCount("ec-only@mail.example")).toBe(0);
      },
    );
  });

  it("trims the Access team domain before checking the issuer", async () => {
    await withAccessEnv(
      { CF_ACCESS_TEAM_DOMAIN: "  https://tstodon.cloudflareaccess.com/  " },
      async () => {
        const page = await browser(await signAccessJwt({ email: "trim-team@mail.example" }))(
          "/auth/sign_in",
        );
        expect(await page.text()).toContain("@trim_team");
      },
    );
  });

  it("sets admin from Access groups and leaves a hand-edited role alone when the list is empty", async () => {
    const email = "group-admin@mail.example";
    await withAccessEnv({ CF_ACCESS_ADMIN_GROUPS: LOCAL_ACCESS_ADMIN_GROUP }, async () => {
      const promoted = await browser(
        await signAccessJwt({ email, groups: [LOCAL_ACCESS_ADMIN_GROUP] }),
      )("/auth/sign_in");
      expect(await promoted.text()).toContain("@group_admin");
      expect(await userRole(email)).toBe("admin");
      await browser(await signAccessJwt({ email }))("/auth/sign_in");
      expect(await userRole(email)).toBe("user");
      await browser(await signAccessJwt({ email, groups: [LOCAL_ACCESS_ADMIN_GROUP] }))(
        "/auth/sign_in",
      );
      expect(await userRole(email)).toBe("admin");
    });

    await withAccessEnv(
      { CF_ACCESS_ADMIN_GROUPS: "", ADMIN_USERNAMES: "grant_admin" },
      async () => {
        const granted = "grant_admin@mail.example";
        await browser(await signAccessJwt({ email: granted }))("/auth/sign_in");
        expect(await userRole(granted)).toBe("admin");
        await env.DB.prepare(`UPDATE "user" SET role = 'user' WHERE email = ?`).bind(granted).run();
        await browser(await signAccessJwt({ email: granted }))("/auth/sign_in");
        expect(await userRole(granted)).toBe("user");

        const kept = "hand-admin@mail.example";
        await browser(await signAccessJwt({ email: kept }))("/auth/sign_in");
        expect(await userRole(kept)).toBe("user");
        await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE email = ?`).bind(kept).run();
        await browser(await signAccessJwt({ email: kept }))("/auth/sign_in");
        expect(await userRole(kept)).toBe("admin");
      },
    );
  });

  it("rebuilds a session whose user is not the Access account", async () => {
    const { fetcher } = await signUp("rebind_one");
    await signUp("rebind_two");
    const app = await registerApp();
    const session = read(
      z.object({ id: z.string(), token: z.string(), userId: z.string() }),
      await env.DB.prepare(
        `SELECT s.id AS id, s.token AS token, s.userId AS userId
         FROM "session" s JOIN accounts a ON a.auth_user_id = s.userId
         WHERE a.username = 'rebind_one'`,
      ).first(),
    );
    const other = read(
      z.object({ id: z.string(), userId: z.string() }),
      await env.DB.prepare(
        `SELECT id, auth_user_id AS userId FROM accounts WHERE username = 'rebind_two'`,
      ).first(),
    );
    await env.DB.prepare(`UPDATE "session" SET userId = ? WHERE id = ?`)
      .bind(other.userId, session.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO oauth_access_tokens
         (id, token_hash, application_id, account_id, scopes, web_session_id, created_at)
       VALUES (?, 'stale-rebind-hash', ?, ?, 'read', ?, '2020-01-01T00:00:00.000Z')`,
    )
      .bind(`web:${session.id}`, app.id, other.id, session.id)
      .run();
    expect((await fetcher("/auth/sign_in")).status).toBe(200);
    const rebuilt = read(
      z.object({ token: z.string(), userId: z.string() }),
      await env.DB.prepare(`SELECT token, userId FROM "session" WHERE id = ?`)
        .bind(session.id)
        .first(),
    );
    expect(rebuilt.userId).toBe(session.userId);
    expect(rebuilt.token).not.toBe(session.token);
    expect(
      await env.DB.prepare(`SELECT id FROM oauth_access_tokens WHERE id = ?`)
        .bind(`web:${session.id}`)
        .first(),
    ).toBeNull();
  });

  it("deletes a user row only when this request created it", async () => {
    const keptEmail = "person@kept-user.example";
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
       VALUES ('user-kept-existing', 'kept', ?, 1, 1, 1, 'user')`,
    )
      .bind(keptEmail)
      .run();
    await env.DB.prepare(
      `INSERT INTO email_domain_blocks (id, domain, created_at) VALUES (?, 'kept-user.example', '2020-01-01T00:00:00.000Z')`,
    )
      .bind("block-kept-user")
      .run();
    const kept = await browser(await signAccessJwt({ email: keptEmail }))("/auth/sign_in");
    expect(await kept.text()).not.toContain("@person");
    expect(
      await env.DB.prepare(`SELECT id FROM "user" WHERE id = 'user-kept-existing'`).first("id"),
    ).toBe("user-kept-existing");
    expect(await accountCount(keptEmail)).toBe(0);

    await env.DB.prepare(
      `INSERT INTO email_domain_blocks (id, domain, created_at) VALUES ('block-fresh-user', 'fresh-block.example', '2020-01-01T00:00:00.000Z')`,
    ).run();
    await browser(await signAccessJwt({ email: "new@fresh-block.example" }))("/auth/sign_in");
    expect(
      await env.DB.prepare(`SELECT id FROM "user" WHERE email = 'new@fresh-block.example'`).first(
        "id",
      ),
    ).toBeNull();
    expect(await accountCount("new@fresh-block.example")).toBe(0);
  });

  it("sends an Access assertion unless the caller asks for a bearer header", async () => {
    const headers = await accessAuthHeaders("header-default@mail.example");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Cf-Access-Jwt-Assertion"]?.length).toBeGreaterThan(0);
    const bearerHeaders = await accessAuthHeaders("header-default@mail.example", {
      via: "bearer",
    });
    expect(bearerHeaders.Authorization?.startsWith("Bearer ")).toBe(true);
    expect(bearerHeaders["Cf-Access-Jwt-Assertion"]).toBeUndefined();
  });
});
