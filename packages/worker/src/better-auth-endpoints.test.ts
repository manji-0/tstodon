import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { browser, type Browser, ORIGIN, postJson, read, signUp } from "../test/passkey-browser";
import { softPasskey, type SoftPasskey } from "../test/soft-passkey";

const AuthOptionsSchema = z.object({ challenge: z.string(), rpId: z.string().optional() });
const RegisterOptionsSchema = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string().optional() }),
});

const userIdOf = async (username: string): Promise<string> => {
  const row = await env.DB.prepare(`SELECT auth_user_id AS id FROM accounts WHERE username = ?`)
    .bind(username)
    .first("id");
  return read(z.string(), row);
};

const userRow = async (userId: string) =>
  env.DB.prepare(`SELECT * FROM "user" WHERE "id" = ?`).bind(userId).first();

const sessionRows = async (userId: string) =>
  (
    await env.DB.prepare(`SELECT * FROM "session" WHERE "userId" = ? ORDER BY "createdAt", "id"`)
      .bind(userId)
      .all()
  ).results;

const passkeyRows = async (userId: string) =>
  (await env.DB.prepare(`SELECT * FROM "passkey" WHERE "userId" = ? ORDER BY "id"`).bind(userId).all())
    .results;

const accountRows = async (userId: string) =>
  (await env.DB.prepare(`SELECT * FROM "account" WHERE "userId" = ? ORDER BY "id"`).bind(userId).all())
    .results;

const makeAdmin = async (username: string): Promise<void> => {
  await env.DB.prepare(`UPDATE "user" SET "role" = 'admin' WHERE "id" = ?`)
    .bind(await userIdOf(username))
    .run();
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

/**
 * Every endpoint Better Auth 1.7.12 serves with the core, admin, and passkey
 * plugins, less the ones the sign-in, sign-up, and Password and security
 * pages call (`/get-session`, `/sign-out`, and the four passkey ceremony
 * endpoints).
 */
const UNCALLED_ENDPOINTS = [
  ["GET", "/account-info"],
  ["POST", "/admin/ban-user"],
  ["POST", "/admin/create-user"],
  ["GET", "/admin/get-user"],
  ["POST", "/admin/has-permission"],
  ["POST", "/admin/impersonate-user"],
  ["POST", "/admin/list-user-sessions"],
  ["GET", "/admin/list-users"],
  ["POST", "/admin/remove-user"],
  ["POST", "/admin/revoke-user-session"],
  ["POST", "/admin/revoke-user-sessions"],
  ["POST", "/admin/set-role"],
  ["POST", "/admin/set-user-password"],
  ["POST", "/admin/stop-impersonating"],
  ["POST", "/admin/unban-user"],
  ["POST", "/admin/update-user"],
  ["GET", "/callback/x"],
  ["POST", "/change-email"],
  ["POST", "/change-password"],
  ["POST", "/delete-user"],
  ["GET", "/delete-user/callback"],
  ["GET", "/error"],
  ["POST", "/get-access-token"],
  ["POST", "/link-social"],
  ["GET", "/list-accounts"],
  ["GET", "/list-sessions"],
  ["GET", "/ok"],
  ["POST", "/passkey/delete-passkey"],
  ["GET", "/passkey/list-user-passkeys"],
  ["POST", "/passkey/update-passkey"],
  ["POST", "/refresh-token"],
  ["POST", "/request-password-reset"],
  ["POST", "/reset-password"],
  ["GET", "/reset-password/x"],
  ["POST", "/revoke-other-sessions"],
  ["POST", "/revoke-session"],
  ["POST", "/revoke-sessions"],
  ["POST", "/send-verification-email"],
  ["POST", "/sign-in/email"],
  ["POST", "/sign-in/social"],
  ["POST", "/sign-up/email"],
  ["POST", "/unlink-account"],
  ["POST", "/update-session"],
  ["POST", "/update-user"],
  ["GET", "/verify-email"],
  ["POST", "/verify-password"],
] as const;

describe("Better Auth endpoints tstodon does not call", () => {
  it("closes every endpoint the pages do not call, even to a fresh admin sign-in", async () => {
    const { fetcher } = await signUp("bae_sweep");
    await makeAdmin("bae_sweep");
    for (const [method, path] of UNCALLED_ENDPOINTS) {
      const response =
        method === "GET"
          ? await fetcher(`/api/auth${path}`)
          : await postJson(fetcher, `/api/auth${path}`, {});
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect((await fetcher("/auth/edit")).status).toBe(200);
  });

  it("keeps /update-user from changing the user's name or picture", async () => {
    const { fetcher } = await signUp("bae_update_user");
    const userId = await userIdOf("bae_update_user");
    const before = await userRow(userId);

    await postJson(fetcher, "/api/auth/update-user", {
      name: "Changed by a stale cookie",
      image: "https://attacker.example/me.png",
    });

    expect(await userRow(userId)).toEqual(before);
  });

  it("keeps /update-session from changing the session", async () => {
    const { fetcher } = await signUp("bae_update_session");
    const userId = await userIdOf("bae_update_session");
    await env.DB.prepare(`UPDATE "session" SET "updatedAt" = "updatedAt" - 3600000 WHERE "userId" = ?`)
      .bind(userId)
      .run();
    const before = await sessionRows(userId);

    await postJson(fetcher, "/api/auth/update-session", {
      impersonatedBy: userId,
      ipAddress: "203.0.113.9",
      userAgent: "stale cookie",
    });

    expect(await sessionRows(userId)).toEqual(before);
  });

  it("keeps /unlink-account from removing a linked account", async () => {
    const { fetcher } = await signUp("bae_unlink");
    const userId = await userIdOf("bae_unlink");
    const now = Date.now();
    for (const [id, providerId] of [
      ["bae_unlink_a", "github"],
      ["bae_unlink_b", "gitlab"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, `${id}_remote`, providerId, userId, now, now)
        .run();
    }
    const before = await accountRows(userId);
    expect(before).toHaveLength(2);

    await postJson(fetcher, "/api/auth/unlink-account", { accountId: "bae_unlink_a" });

    expect(await accountRows(userId)).toEqual(before);
  });

  it("keeps /passkey/update-passkey from renaming a passkey", async () => {
    const { fetcher } = await signUp("bae_rename_passkey", undefined, "Laptop");
    const userId = await userIdOf("bae_rename_passkey");
    const before = await passkeyRows(userId);
    const id = read(z.object({ id: z.string() }), before[0]).id;

    await postJson(fetcher, "/api/auth/passkey/update-passkey", { id, name: "Renamed" });

    expect(await passkeyRows(userId)).toEqual(before);
  });

  it("keeps /list-sessions from handing out the other sessions' tokens", async () => {
    const { fetcher, passkey } = await signUp("bae_list_sessions");
    await signInAgain(passkey);
    const tokens = read(
      z.array(z.object({ token: z.string() })),
      await sessionRows(await userIdOf("bae_list_sessions")),
    );
    expect(tokens).toHaveLength(2);

    const listed = await (await fetcher("/api/auth/list-sessions")).text();

    for (const { token } of tokens) {
      expect(listed).not.toContain(token);
    }
  });
});

type Target = { id: string; sessionToken: string };

const shortId = (text: string): string =>
  [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_000, 7).toString();

describe("Better Auth admin endpoints", () => {
  const adminAndTarget = async (prefix: string) => {
    const admin = await signUp(`${prefix}_admin`);
    await makeAdmin(`${prefix}_admin`);
    await signUp(`${prefix}_target`);
    const targetId = await userIdOf(`${prefix}_target`);
    const [session] = read(z.array(z.object({ token: z.string() })), await sessionRows(targetId));
    const target: Target = { id: targetId, sessionToken: session?.token ?? "" };
    return {
      admin: admin.fetcher,
      target,
      targetId,
      snapshot: async () => ({
        user: await userRow(targetId),
        sessions: await sessionRows(targetId),
        accounts: await accountRows(targetId),
      }),
    };
  };

  it.each([
    ["/admin/revoke-user-session", (target: Target) => ({ sessionToken: target.sessionToken })],
    ["/admin/revoke-user-sessions", (target: Target) => ({ userId: target.id })],
    ["/admin/set-role", (target: Target) => ({ userId: target.id, role: "admin" })],
    ["/admin/ban-user", (target: Target) => ({ userId: target.id, banReason: "stale cookie" })],
    [
      "/admin/update-user",
      (target: Target) => ({ userId: target.id, data: { name: "Renamed by admin" } }),
    ],
    [
      "/admin/set-user-password",
      (target: Target) => ({ userId: target.id, newPassword: "correct horse battery" }),
    ],
    ["/admin/impersonate-user", (target: Target) => ({ userId: target.id })],
    ["/admin/remove-user", (target: Target) => ({ userId: target.id })],
  ] as const)("keeps %s from changing another user or their sessions", async (path, body) => {
    // Usernames are at most 30 characters, too short for the endpoint name.
    const { admin, target, snapshot } = await adminAndTarget(`bae_${shortId(path)}`);
    const before = await snapshot();
    expect(read(z.object({ role: z.string() }), before.user).role).toBe("user");

    await postJson(admin, `/api/auth${path}`, body(target));

    expect(await snapshot()).toEqual(before);
  });

  it("does not let an admin cookie create a user without a confirmed sign-up link", async () => {
    const { admin } = await adminAndTarget("bae_admin_create");

    await postJson(admin, "/api/auth/admin/create-user", {
      email: "made-by-admin@mail.example",
      name: "made_by_admin",
      password: "correct horse battery",
    });

    const made = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "email" = ?`)
      .bind("made-by-admin@mail.example")
      .first("n");
    expect(made).toBe(0);
  });

  it("does not let an admin cookie list users and their sessions", async () => {
    const { admin, targetId } = await adminAndTarget("bae_admin_list");
    const [targetSession] = read(z.array(z.object({ token: z.string() })), await sessionRows(targetId));

    const users = await (await admin("/api/auth/admin/list-users")).text();
    const sessions = await (
      await postJson(admin, "/api/auth/admin/list-user-sessions", { userId: targetId })
    ).text();

    expect(users).not.toContain("bae_admin_list_target@mail.example");
    expect(sessions).not.toContain(targetSession?.token);
  });
});

describe("Better Auth endpoints the pages call", () => {
  it("signs in with a passkey, reads the session, and signs out", async () => {
    const { passkey } = await signUp("bae_flow");
    const userId = await userIdOf("bae_flow");
    const second = await signInAgain(passkey);
    expect(await sessionRows(userId)).toHaveLength(2);

    const session = await second("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(read(z.object({ user: z.object({ id: z.string() }) }), await session.json()).user.id).toBe(
      userId,
    );

    const signedOut = await postJson(second, "/api/auth/sign-out", {});
    expect(signedOut.status).toBe(200);
    expect(await sessionRows(userId)).toHaveLength(1);
    expect(await (await second("/api/auth/get-session")).json()).toBeNull();
  });

  it("adds a passkey for a signed-in user with a recent sign-in", async () => {
    const { fetcher } = await signUp("bae_add_passkey");
    const options = await fetcher(
      `/api/auth/passkey/generate-register-options?${new URLSearchParams({ name: "Phone" }).toString()}`,
    );
    expect(options.status).toBe(200);
    const passkey = await softPasskey(ORIGIN);
    const response = await passkey.register(read(RegisterOptionsSchema, await options.json()));
    const verified = await postJson(fetcher, "/api/auth/passkey/verify-registration", {
      response,
      name: "Phone",
    });
    expect(verified.status).toBe(200);
    expect(await passkeyRows(await userIdOf("bae_add_passkey"))).toHaveLength(2);
  });
});
