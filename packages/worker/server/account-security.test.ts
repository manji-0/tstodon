import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { browser, ORIGIN, postForm, postJson, read, signUp } from "../test/passkey-browser";
import { signedInAccount } from "../test/auth-fixture";
import { findAccountByUsername } from "./account-store";
import { listSessions } from "./account-security-store";
import { ensureWebAccessToken, ensureWebApplication } from "./generated/prisma/sql";
import { issueAccessToken, registerOauthApplication, sha256Hex } from "./oauth-store";
import { runTypedBatch } from "./typed-sql";

const account = async (username: string) => {
  const found = await findAccountByUsername(env.DB, username);
  if (found.isErr() || !found.value) {
    throw new Error(`no account ${username}`);
  }
  return found.value;
};

const userIdOf = async (username: string): Promise<string> => {
  const row = await env.DB.prepare(`SELECT auth_user_id AS id FROM accounts WHERE username = ?`)
    .bind(username)
    .first("id");
  return read(z.string(), row);
};

const sessionsOf = async (username: string) => {
  const found = await listSessions(env.DB, await userIdOf(username));
  if (found.isErr()) {
    throw new Error(found.error.message);
  }
  return found.value;
};

/** Make every session of `username` look like it started an hour ago. */
const ageSessions = async (username: string): Promise<void> => {
  await env.DB.prepare(
    `UPDATE "session" SET "createdAt" = "createdAt" - 3600000 WHERE "userId" = ?`,
  )
    .bind(await userIdOf(username))
    .run();
};

const page = async (response: Response): Promise<string> => response.text();

const verifyCredentials = (token: string) =>
  SELF.fetch(`${ORIGIN}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${token}` },
  });

const authorizeApp = async (name: string, username: string) => {
  const registered = await registerOauthApplication(env.DB, {
    name,
    website: null,
    redirectUris: ["urn:ietf:wg:oauth:2.0:oob"],
    scopes: ["read"],
  });
  if (registered.isErr()) {
    throw new Error(registered.error.message);
  }
  const issued = await issueAccessToken(env.DB, {
    applicationId: registered.value.application.id,
    accountId: (await account(username)).id,
    scopes: ["read"],
  });
  if (issued.isErr()) {
    throw new Error(issued.error.message);
  }
  return { applicationId: registered.value.application.id, token: issued.value.token };
};

describe("Password and security: who may use it", () => {
  it("sends a signed-out browser to sign in, for the page and every action", async () => {
    const signedOut = await SELF.fetch(`${ORIGIN}/auth/edit`, { redirect: "manual" });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe("/auth/sign_in?return_to=%2Fauth%2Fedit");
    for (const path of [
      "/auth/edit/sessions/revoke",
      "/auth/edit/authorized_applications/revoke",
    ]) {
      const posted = await postForm(browser(), path, { id: "x", name: "x" });
      expect(posted.status, path).toBe(302);
      expect(posted.headers.get("location"), path).toContain("/auth/sign_in");
    }
  });

  it("refuses an action posted from another site, and changes nothing", async () => {
    const { fetcher } = await signUp("sec_cross_site");
    const sessionId = (await sessionsOf("sec_cross_site"))[0]?.id ?? "";
    const app = await authorizeApp("Cross Site App", "sec_cross_site");

    const crossSite = (path: string, fields: Record<string, string>) =>
      fetcher(path, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
        },
        body: new URLSearchParams(fields).toString(),
      });
    for (const [path, fields] of [
      ["/auth/edit/sessions/revoke", { id: sessionId }],
      ["/auth/edit/authorized_applications/revoke", { id: app.applicationId }],
    ] as const) {
      expect((await crossSite(path, fields)).status, path).toBe(403);
    }

    expect(await sessionsOf("sec_cross_site")).toHaveLength(1);
    expect((await verifyCredentials(app.token)).status).toBe(200);
  });
});

describe("Password and security: Access owns passkeys", () => {
  it("tells the signed-in user that passkeys live in Access", async () => {
    const { fetcher } = await signUp("sec_access_passkeys");
    const shown = await page(await fetcher("/auth/edit"));
    expect(shown).toContain("Cloudflare Access");
    expect(shown).not.toContain("Create passkey");
    expect(shown).not.toContain('action="/auth/edit/passkeys/remove"');
    expect((await fetcher("/api/auth/passkey/generate-register-options")).status).not.toBe(200);
  });
});

describe("Password and security: browser sessions", () => {
  it("lists the Access session and sends this browser to Access logout", async () => {
    const { fetcher } = await signUp("sec_sessions");
    const sessions = await sessionsOf("sec_sessions");
    expect(sessions).toHaveLength(1);
    const shown = await page(await fetcher("/auth/edit"));
    expect(shown.match(/This browser/g)).toHaveLength(1);

    const own = await postForm(fetcher, "/auth/edit/sessions/revoke", {
      id: sessions[0]?.id ?? "",
    });
    expect(own.status).toBe(303);
    expect(own.headers.get("location")).toBe("/cdn-cgi/access/logout");
    expect(own.headers.getSetCookie().join("\n")).toMatch(/session_token=; .*Max-Age=0/);
    expect(await sessionsOf("sec_sessions")).toHaveLength(0);
    // The assertion is still on the request, so the next view signs in again.
    expect((await fetcher("/auth/edit")).status).toBe(200);
    expect((await browser()("/auth/edit")).status).toBe(302);
  });

  it("does not let a user end another user's session", async () => {
    const victim = await signUp("sec_victim");
    const { fetcher: attacker } = await signUp("sec_session_attacker");
    const victimSession = (await sessionsOf("sec_victim"))[0]?.id ?? "";

    const response = await postForm(attacker, "/auth/edit/sessions/revoke", { id: victimSession });
    expect(response.status).toBe(404);
    expect(await sessionsOf("sec_victim")).toHaveLength(1);
    expect((await victim.fetcher("/auth/edit")).status).toBe(200);
  });

  it("keeps Better Auth's own revoke endpoints from ending the Access session", async () => {
    const { fetcher } = await signUp("sec_builtin_revoke");
    const token = read(
      z.object({ token: z.string() }),
      await env.DB.prepare(`SELECT "token" FROM "session" WHERE "userId" = ?`)
        .bind(await userIdOf("sec_builtin_revoke"))
        .first(),
    ).token;

    for (const [path, body] of [
      ["/api/auth/revoke-session", { token }],
      ["/api/auth/revoke-sessions", {}],
      ["/api/auth/revoke-other-sessions", {}],
    ] as const) {
      expect((await postJson(fetcher, path, body)).status, path).toBe(403);
    }
    expect(await sessionsOf("sec_builtin_revoke")).toHaveLength(1);
    expect((await fetcher("/auth/edit")).status).toBe(200);
  });

  it("refuses to end a session when the sign-in is stale", async () => {
    const { fetcher } = await signUp("sec_session_stale");
    await ageSessions("sec_session_stale");
    const target = (await sessionsOf("sec_session_stale"))[0]?.id ?? "";

    const shown = await page(await fetcher("/auth/edit"));
    expect(shown).toContain("sign in again through Cloudflare Access");
    expect(shown).not.toContain('action="/auth/edit/sessions/revoke"');

    const refused = await postForm(fetcher, "/auth/edit/sessions/revoke", { id: target });
    expect(refused.status).toBe(403);
    expect(await sessionsOf("sec_session_stale")).toHaveLength(1);
  });
});

describe("Password and security: authorized apps", () => {
  it("lists an app and revokes its tokens, leaving other accounts' tokens alone", async () => {
    const { fetcher } = await signUp("sec_apps");
    const mine = await authorizeApp("Pinafore", "sec_apps");
    const other = await signedInAccount("sec-apps-other@example.com");
    const issued = await issueAccessToken(env.DB, {
      applicationId: mine.applicationId,
      accountId: other.id,
      scopes: ["read"],
    });
    if (issued.isErr()) {
      throw new Error(issued.error.message);
    }

    const shown = await page(await fetcher("/auth/edit"));
    expect(shown).toContain("Pinafore");
    expect(shown).toContain("<code>read</code>");

    const revoked = await postForm(fetcher, "/auth/edit/authorized_applications/revoke", {
      id: mine.applicationId,
    });
    expect(revoked.status).toBe(200);
    expect(await page(revoked)).toContain("Access revoked.");
    expect((await verifyCredentials(mine.token)).status).toBe(401);
    expect((await verifyCredentials(issued.value.token)).status).toBe(200);
    expect(await page(await fetcher("/auth/edit"))).not.toContain("Pinafore");
  });

  it("does not let a user revoke an app another account authorized", async () => {
    const { fetcher } = await signUp("sec_app_attacker");
    await signUp("sec_app_owner");
    const owners = await authorizeApp("Owner App", "sec_app_owner");

    const response = await postForm(fetcher, "/auth/edit/authorized_applications/revoke", {
      id: owners.applicationId,
    });
    expect(response.status).toBe(404);
    expect((await verifyCredentials(owners.token)).status).toBe(200);
  });

  it("refuses to revoke when the sign-in is stale", async () => {
    const { fetcher } = await signUp("sec_app_stale");
    const app = await authorizeApp("Stale App", "sec_app_stale");
    await ageSessions("sec_app_stale");

    const refused = await postForm(fetcher, "/auth/edit/authorized_applications/revoke", {
      id: app.applicationId,
    });
    expect(refused.status).toBe(403);
    expect((await verifyCredentials(app.token)).status).toBe(200);
  });

  it("treats the web app's token as part of its browser session, not as an app", async () => {
    const { fetcher } = await signUp("sec_web_token");
    // What the web app records on its first page load for a session.
    const sessionId = (await sessionsOf("sec_web_token"))[0]?.id ?? "";
    const seeded = await runTypedBatch(env.DB, [
      ensureWebApplication("tstodon-web", "read write follow push", new Date().toISOString()),
      ensureWebAccessToken(
        `web:${sessionId}`,
        await sha256Hex("web-token"),
        "tstodon-web",
        (await account("sec_web_token")).id,
        "read write follow push",
        sessionId,
        new Date().toISOString(),
      ),
    ]);
    expect(seeded.isOk()).toBe(true);
    const webTokens = async (): Promise<number> =>
      read(
        z.number(),
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM oauth_access_tokens t JOIN accounts a ON a.id = t.account_id
           WHERE a.username = ? AND t.web_session_id IS NOT NULL`,
        )
          .bind("sec_web_token")
          .first("n"),
      );
    expect(await webTokens()).toBe(1);
    expect(await page(await fetcher("/auth/edit"))).not.toContain("tstodon-web");

    const refused = await postForm(fetcher, "/auth/edit/authorized_applications/revoke", {
      id: "tstodon-web",
    });
    expect(refused.status).toBe(404);
    expect(await webTokens()).toBe(1);

    // Ending the session is what ends its token.
    await postForm(fetcher, "/auth/edit/sessions/revoke", { id: sessionId });
    expect(await webTokens()).toBe(0);
  });
});
