import { AccessEmail, Username, type LocalAccount } from "@tstodon/domain";
import { env } from "cloudflare:test";
import { provisionLocalAccount } from "../src/account-provision";
import { findAccountByEmail, findAccountByUsername } from "../src/account-store";
import { issueAccessToken } from "../src/oauth-store";
import { registrationApprovalRequired } from "../src/runtime-config";

/**
 * Test-only sign-in: seed what a passkey sign-up and an OAuth authorization
 * would leave in D1 (a Better Auth user, its local account, an app, and an
 * access token) without the browser ceremony. `email` names the person; the
 * account's username is derived from it, as the Access-era fixture did.
 */

const FIXTURE_APP_ID = "test-fixture-app";

export const ALL_SCOPES = ["read", "write", "follow", "push", "admin:read", "admin:write"];

const ensureFixtureApp = async (): Promise<void> => {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO oauth_applications (id, client_id, client_secret_hash, name, redirect_uris, scopes)
     VALUES (?, ?, '', 'tstodon tests', 'urn:ietf:wg:oauth:2.0:oob', ?)`,
  )
    .bind(FIXTURE_APP_ID, FIXTURE_APP_ID, ALL_SCOPES.join(" "))
    .run();
};

const fixtureUsername = async (email: AccessEmail): Promise<string> => {
  const base = Username.deriveFromEmail(email, false);
  if (base.isErr()) {
    throw new Error(`no username for ${email}`);
  }
  const taken = await findAccountByUsername(env.DB, base.value);
  if (taken.isErr() || !taken.value) {
    return base.value;
  }
  const suffixed = Username.deriveFromEmail(email, true);
  if (suffixed.isErr()) {
    throw new Error(`no username for ${email}`);
  }
  return suffixed.value;
};

/**
 * The account signed in as `email`, created on first use (`pending` as with
 * `REGISTRATION_APPROVAL`); `admin` sets its role.
 */
export const signedInAccount = async (
  rawEmail: string,
  options?: Readonly<{ admin?: boolean; pending?: boolean }>,
): Promise<LocalAccount> => {
  const email = AccessEmail.parse(rawEmail);
  if (email.isErr()) {
    throw new Error(`invalid email ${rawEmail}`);
  }
  const role = options?.admin ? "admin" : "user";
  const existing = await findAccountByEmail(env.DB, email.value);
  if (existing.isErr()) {
    throw new Error(existing.error.message);
  }
  if (existing.value) {
    await env.DB.prepare(
      `UPDATE "user" SET role = ? WHERE id = (SELECT auth_user_id FROM accounts WHERE id = ?)`,
    )
      .bind(role, existing.value.id)
      .run();
    return existing.value;
  }
  const userId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(userId, email.value, email.value, now, now, role)
    .run();
  const account = await provisionLocalAccount(env.DB, {
    username: await fixtureUsername(email.value),
    email: email.value,
    authUserId: userId,
    pending: options?.pending ?? registrationApprovalRequired(env),
  });
  if (account.isErr()) {
    // As the sign-up does, drop the Better Auth user the refusal orphaned.
    await env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(userId).run();
    throw new Error(`could not provision ${rawEmail}: ${account.error.kind}`);
  }
  return account.value;
};

/** A fresh access token for the account at `accountId`. */
export const accessTokenFor = async (
  accountId: string | undefined,
  scopes: ReadonlyArray<string> = ALL_SCOPES,
): Promise<string> => {
  await ensureFixtureApp();
  const issued = await issueAccessToken(env.DB, {
    applicationId: FIXTURE_APP_ID,
    accountId,
    scopes,
  });
  if (issued.isErr()) {
    throw new Error(issued.error.message);
  }
  return issued.value.token;
};

/** `Authorization` for a request made as `email` (and as an admin with `admin`). */
export const authHeaders = async (
  email: string,
  options?: Readonly<{ admin?: boolean; scopes?: ReadonlyArray<string> }>,
): Promise<Record<string, string>> => {
  const account = await signedInAccount(email, options);
  return { Authorization: `Bearer ${await accessTokenFor(account.id, options?.scopes)}` };
};
