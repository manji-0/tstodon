import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
  browser,
  type Browser,
  ORIGIN,
  postForm,
  postJson,
  read,
  registrationOptions,
  requestSignupLink,
  signUp,
} from "../test/passkey-browser";
import { softPasskey, type SoftPasskey } from "../test/soft-passkey";
import { signedInAccount } from "../test/auth-fixture";
import { findAccountByUsername } from "./account-store";
import { listPasskeys, listSessions } from "./account-security-store";
import { ensureWebAccessToken, ensureWebApplication } from "./generated/prisma/sql";
import { issueAccessToken, registerOauthApplication, sha256Hex } from "./oauth-store";
import { runTypedBatch } from "./typed-sql";

const OptionsSchema = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string().optional() }),
});
const AuthOptionsSchema = z.object({ challenge: z.string(), rpId: z.string().optional() });

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

const passkeysOf = async (username: string) => {
  const found = await listPasskeys(env.DB, await userIdOf(username));
  if (found.isErr()) {
    throw new Error(found.error.message);
  }
  return found.value;
};

const sessionsOf = async (username: string) => {
  const found = await listSessions(env.DB, await userIdOf(username));
  if (found.isErr()) {
    throw new Error(found.error.message);
  }
  return found.value;
};

/** A new browser session for the passkey's user, as the sign-in page makes one. */
const signInAgain = async (passkey: SoftPasskey): Promise<Browser> => {
  const fetcher = browser();
  const options = await fetcher("/api/auth/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  const response = await passkey.authenticate(read(AuthOptionsSchema, await options.json()));
  const verified = await postJson(fetcher, "/api/auth/passkey/verify-authentication", { response });
  expect(verified.status).toBe(200);
  return fetcher;
};

/** Add a passkey the way the page's script does: Better Auth's registration endpoints. */
const addPasskey = async (fetcher: Browser, name: string) => {
  const options = await fetcher(
    `/api/auth/passkey/generate-register-options?${new URLSearchParams({ name }).toString()}`,
  );
  if (options.status !== 200) {
    return options;
  }
  const passkey = await softPasskey(ORIGIN);
  const response = await passkey.register(read(OptionsSchema, await options.json()));
  return postJson(fetcher, "/api/auth/passkey/verify-registration", { response, name });
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
      "/auth/edit/passkeys/rename",
      "/auth/edit/passkeys/remove",
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
    const second = await addPasskey(fetcher, "Second");
    expect(second.status).toBe(200);
    const passkeyId = (await passkeysOf("sec_cross_site"))[0]?.id ?? "";
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
      ["/auth/edit/passkeys/rename", { id: passkeyId, name: "Hijacked" }],
      ["/auth/edit/passkeys/remove", { id: passkeyId }],
      ["/auth/edit/sessions/revoke", { id: sessionId }],
      ["/auth/edit/authorized_applications/revoke", { id: app.applicationId }],
    ] as const) {
      expect((await crossSite(path, fields)).status, path).toBe(403);
    }

    expect(await passkeysOf("sec_cross_site")).toHaveLength(2);
    expect((await passkeysOf("sec_cross_site"))[0]?.name).not.toBe("Hijacked");
    expect(await sessionsOf("sec_cross_site")).toHaveLength(1);
    expect((await verifyCredentials(app.token)).status).toBe(200);
  });
});

describe("Password and security: signing up while signed in", () => {
  it("refuses a sign-up link in a signed-in browser instead of adding a passkey to that account", async () => {
    const { fetcher } = await signUp("sec_signup_owner");
    const before = await passkeysOf("sec_signup_owner");
    const token = await requestSignupLink(
      browser(),
      "sec_signup_new",
      "sec_signup_new@mail.example",
    );

    const page = await fetcher(`/auth/sign_up/verify?${new URLSearchParams({ token }).toString()}`);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("Sign out first");
    expect((await registrationOptions(fetcher, token)).status).toBe(403);

    expect(await passkeysOf("sec_signup_owner")).toHaveLength(before.length);
    const created = await findAccountByUsername(env.DB, "sec_signup_new");
    expect(created.isOk() && created.value).toBeFalsy();
    // The link is still good for a signed-out browser.
    const fresh = await browser()(
      `/auth/sign_up/verify?${new URLSearchParams({ token }).toString()}`,
    );
    expect(fresh.status).toBe(200);
  });
});

describe("Password and security: passkeys", () => {
  it("lists, adds, renames, and removes passkeys, and keeps the last one", async () => {
    const { fetcher } = await signUp("sec_passkeys");
    const shown = await page(await fetcher("/auth/edit"));
    expect(shown).toContain("<h1>Password and security</h1>");
    expect(shown).toContain("This is your only passkey");
    expect(shown).not.toContain('action="/auth/edit/passkeys/remove"');

    const added = await addPasskey(fetcher, "Laptop");
    expect(added.status).toBe(200);
    const [first, second] = await passkeysOf("sec_passkeys");
    expect(second?.name).toBe("Laptop");
    expect(await page(await fetcher("/auth/edit"))).toContain("Laptop");

    const renamed = await postForm(fetcher, "/auth/edit/passkeys/rename", {
      id: second?.id ?? "",
      name: "  Work laptop ",
    });
    expect(renamed.status).toBe(200);
    expect(await page(renamed)).toContain("Passkey renamed.");
    expect((await passkeysOf("sec_passkeys"))[1]?.name).toBe("Work laptop");
    const blank = await postForm(fetcher, "/auth/edit/passkeys/rename", {
      id: second?.id ?? "",
      name: "  ",
    });
    expect(blank.status).toBe(422);

    const removed = await postForm(fetcher, "/auth/edit/passkeys/remove", { id: second?.id ?? "" });
    expect(removed.status).toBe(200);
    expect(await page(removed)).toContain("Passkey removed.");
    expect(await passkeysOf("sec_passkeys")).toHaveLength(1);

    const last = await postForm(fetcher, "/auth/edit/passkeys/remove", { id: first?.id ?? "" });
    expect(last.status).toBe(422);
    expect(await page(last)).toContain("This is your only passkey");
    expect(await passkeysOf("sec_passkeys")).toHaveLength(1);
  });

  it("keeps Better Auth's own delete endpoint from skipping the last-passkey rule", async () => {
    const { fetcher } = await signUp("sec_builtin_delete");
    const only = (await passkeysOf("sec_builtin_delete"))[0]?.id ?? "";
    const refused = await postJson(fetcher, "/api/auth/passkey/delete-passkey", { id: only });
    expect(refused.status).toBe(403);
    expect(await passkeysOf("sec_builtin_delete")).toHaveLength(1);
  });

  it("does not let one user rename or remove another user's passkey", async () => {
    const owner = await signUp("sec_owner");
    expect((await addPasskey(owner.fetcher, "Spare")).status).toBe(200);
    const [ownerKey] = await passkeysOf("sec_owner");
    const { fetcher: attacker } = await signUp("sec_attacker");
    expect((await addPasskey(attacker, "Spare")).status).toBe(200);

    const rename = await postForm(attacker, "/auth/edit/passkeys/rename", {
      id: ownerKey?.id ?? "",
      name: "Stolen",
    });
    expect(rename.status).toBe(404);
    const remove = await postForm(attacker, "/auth/edit/passkeys/remove", {
      id: ownerKey?.id ?? "",
    });
    expect(remove.status).toBe(404);
    expect((await passkeysOf("sec_owner")).map((passkey) => passkey.name)).not.toContain("Stolen");
    expect(await passkeysOf("sec_owner")).toHaveLength(2);
    expect(await passkeysOf("sec_attacker")).toHaveLength(2);
  });

  it("asks for a recent sign-in before it removes or adds a passkey", async () => {
    const { fetcher } = await signUp("sec_stale");
    expect((await addPasskey(fetcher, "Spare")).status).toBe(200);
    const [first, second] = await passkeysOf("sec_stale");
    await ageSessions("sec_stale");

    const shown = await page(await fetcher("/auth/edit"));
    expect(shown).toContain("signInWithPasskey");
    expect(shown).not.toContain('action="/auth/edit/passkeys/remove"');
    expect(shown).not.toContain('id="add-passkey"');

    const removed = await postForm(fetcher, "/auth/edit/passkeys/remove", { id: first?.id ?? "" });
    expect(removed.status).toBe(403);
    expect(await passkeysOf("sec_stale")).toHaveLength(2);
    expect((await addPasskey(fetcher, "Late")).status).toBe(403);
    expect(await passkeysOf("sec_stale")).toHaveLength(2);

    // Renaming is not a destructive action.
    const renamed = await postForm(fetcher, "/auth/edit/passkeys/rename", {
      id: second?.id ?? "",
      name: "Renamed while stale",
    });
    expect(renamed.status).toBe(200);
  });
});

describe("Password and security: browser sessions", () => {
  it("lists sessions, ends another one, and signs this browser out when it ends its own", async () => {
    const { fetcher, passkey } = await signUp("sec_sessions");
    await env.DB.prepare(`UPDATE "session" SET "createdAt" = "createdAt" - 5000 WHERE "userId" = ?`)
      .bind(await userIdOf("sec_sessions"))
      .run();
    const other = await signInAgain(passkey);
    const sessions = await sessionsOf("sec_sessions");
    expect(sessions).toHaveLength(2);
    const shown = await page(await fetcher("/auth/edit"));
    expect(shown.match(/This browser/g)).toHaveLength(1);

    // The newest session is the second sign-in; the first is `fetcher`'s.
    const [otherSession, ownSession] = sessions;
    const ended = await postForm(fetcher, "/auth/edit/sessions/revoke", {
      id: otherSession?.id ?? "",
    });
    expect(ended.status).toBe(200);
    expect(await page(ended)).toContain("Session ended.");
    expect(await sessionsOf("sec_sessions")).toHaveLength(1);
    const gone = await other("/auth/edit");
    expect(gone.status).toBe(302);
    expect(gone.headers.get("location")).toContain("/auth/sign_in");

    const own = await postForm(fetcher, "/auth/edit/sessions/revoke", { id: ownSession?.id ?? "" });
    expect(own.status).toBe(303);
    expect(own.headers.get("location")).toBe("/auth/sign_in");
    expect(own.headers.getSetCookie().join("\n")).toMatch(/session_token=; .*Max-Age=0/);
    expect(await sessionsOf("sec_sessions")).toHaveLength(0);
    expect((await fetcher("/auth/edit")).status).toBe(302);
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

  it("keeps Better Auth's own revoke endpoints from ending other sessions", async () => {
    const { fetcher, passkey } = await signUp("sec_builtin_revoke");
    const other = await signInAgain(passkey);
    await ageSessions("sec_builtin_revoke");
    const tokens = await env.DB.prepare(`SELECT "token" FROM "session" WHERE "userId" = ? ORDER BY "createdAt"`)
      .bind(await userIdOf("sec_builtin_revoke"))
      .all();
    const otherToken = read(z.array(z.object({ token: z.string() })), tokens.results)[1]?.token;

    for (const [path, body] of [
      ["/api/auth/revoke-session", { token: otherToken }],
      ["/api/auth/revoke-sessions", {}],
      ["/api/auth/revoke-other-sessions", {}],
    ] as const) {
      expect((await postJson(fetcher, path, body)).status, path).toBe(403);
    }
    expect(await sessionsOf("sec_builtin_revoke")).toHaveLength(2);
    expect((await other("/auth/edit")).status).toBe(200);
  });

  it("refuses to end a session when the sign-in is stale", async () => {
    const { fetcher, passkey } = await signUp("sec_session_stale");
    await signInAgain(passkey);
    await ageSessions("sec_session_stale");
    const target = (await sessionsOf("sec_session_stale"))[0]?.id ?? "";

    const refused = await postForm(fetcher, "/auth/edit/sessions/revoke", { id: target });
    expect(refused.status).toBe(403);
    expect(await sessionsOf("sec_session_stale")).toHaveLength(2);
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
