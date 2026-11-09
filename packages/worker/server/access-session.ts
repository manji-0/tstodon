import { Sensitive } from "@tstodon/core";
import {
  FediRole,
  type FediRole as FediRoleValue,
  LocalAccountModeration,
  type LocalAccount,
  Username,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findLocalAccountModeration } from "./account-moderation-store";
import { provisionLocalAccount, signupUsername, type ProvisionError } from "./account-provision";
import { findAccountByEmail } from "./account-store";
import {
  accessAdminGroups,
  accessAssertion,
  accessIdentity,
  identityIsAccessAdmin,
  type AccessIdentity,
} from "./access-jwt";
import { recordAccountActivity, recordSignUpIp } from "./account-activity";
import { notifyAdmins } from "./admin-notify";
import { ipSignUpDecision } from "./ip-access";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { setAccountAuthUser } from "./generated/prisma/sql";
import { sha256Hex } from "./oauth-store";
import { registrationApprovalRequired, registrationsOpen } from "./runtime-config";
import { roleFromAuthUser } from "./auth";
import { runTyped } from "./typed-sql";

/**
 * Turn a verified Access identity into the local account and the Better Auth
 * user it links to. The JWT is the login. The user and session rows are the
 * account link and the web app token's secret, not a second way to sign in.
 */

const AuthUserRowSchema = z.object({ auth_user_id: z.string().nullable() });
const UserIdRowSchema = z.object({ id: z.string() });
const RoleRowSchema = z.object({ role: z.string().nullable() });
const SessionRowSchema = z.object({
  id: z.string(),
  token: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number(),
  userId: z.string(),
});

type SessionRow = z.infer<typeof SessionRowSchema>;
type UserLink = Readonly<{ id: string; created: boolean }>;
type ResolvedAccount = Readonly<{ account: LocalAccount; userCreated: boolean }>;

export type AccessLogin =
  | Readonly<{ kind: "None" }>
  | Readonly<{ kind: "NoAccount" }>
  | Readonly<{ kind: "Barred" }>
  | Readonly<{
      kind: "Account";
      account: LocalAccount;
      role: FediRoleValue;
      signedInAt: Date;
      userId: string;
      sessionId: string;
      sessionToken: string;
    }>;

/** `ADMIN_USERNAMES` grants admin only when this request inserts the user row. */
export const signupRole = (env: Env, username: string): "admin" | "user" =>
  `${env.ADMIN_USERNAMES ?? ""}`
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .includes(username)
    ? "admin"
    : "user";

const sessionIdFor = async (sub: string): Promise<string> =>
  `access:${(await sha256Hex(sub)).slice(0, 32)}`;

const userIdForEmail = async (
  db: D1Database,
  email: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const rows = await runD1(async () => {
    const result = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).all();
    return parseRows(UserIdRowSchema, result.results);
  });
  return rows.map((found) => found[0]?.id);
};

const insertUser = async (
  db: D1Database,
  input: Readonly<{ id: string; username: string; email: string; role: string; now: number }>,
): Promise<Result<UserLink, RepositoryError>> => {
  const inserted = await runD1(() =>
    db
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(input.id, input.username, input.email, input.now, input.now, input.role)
      .run(),
  );
  if (inserted.isOk()) {
    return ok({ id: input.id, created: true });
  }
  const existing = await userIdForEmail(db, input.email);
  if (existing.isErr()) {
    return err(existing.error);
  }
  return existing.value ? ok({ id: existing.value, created: false }) : err(inserted.error);
};

const linkedUserId = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const rows = await runD1(async () => {
    const result = await db
      .prepare(`SELECT auth_user_id FROM accounts WHERE id = ?`)
      .bind(accountId)
      .all();
    return parseRows(AuthUserRowSchema, result.results);
  });
  return rows.map((found) => found[0]?.auth_user_id ?? undefined);
};

const promoteAdmin = async (
  db: D1Database,
  userId: string,
): Promise<Result<void, RepositoryError>> => {
  const updated = await runD1(() =>
    db
      .prepare(
        `UPDATE "user" SET role = 'admin'
         WHERE id = ? AND (role IS NULL OR instr(replace(role, ' ', ''), 'admin') = 0)`,
      )
      .bind(userId)
      .run(),
  );
  return updated.map(() => undefined);
};

/** Drop the `admin` token. Other comma-separated roles stay. */
const roleWithoutAdmin = (role: string | null): string => {
  const kept = (role ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name !== "admin");
  return kept.length > 0 ? kept.join(",") : "user";
};

const clearAdmin = async (
  db: D1Database,
  userId: string,
): Promise<Result<void, RepositoryError>> => {
  const rows = await runD1(async () => {
    const result = await db.prepare(`SELECT role FROM "user" WHERE id = ?`).bind(userId).all();
    return parseRows(RoleRowSchema, result.results);
  });
  if (rows.isErr()) {
    return err(rows.error);
  }
  const current = rows.value[0]?.role ?? null;
  const next = roleWithoutAdmin(current);
  if ((current ?? "user") === next) {
    return ok(undefined);
  }
  const updated = await runD1(() =>
    db.prepare(`UPDATE "user" SET role = ? WHERE id = ?`).bind(next, userId).run(),
  );
  return updated.map(() => undefined);
};

/**
 * A non-empty `CF_ACCESS_ADMIN_GROUPS` is the role on every login after the
 * user row exists. An empty list leaves a hand-edited role alone.
 */
const syncAdminRole = async (
  env: Env,
  identity: AccessIdentity,
  userId: string,
): Promise<Result<void, RepositoryError>> => {
  if (accessAdminGroups(env).size === 0) {
    return ok(undefined);
  }
  return identityIsAccessAdmin(identity, env)
    ? promoteAdmin(env.DB, userId)
    : clearAdmin(env.DB, userId);
};

const createRole = (env: Env, identity: AccessIdentity, username: string): "admin" | "user" =>
  identityIsAccessAdmin(identity, env) || signupRole(env, username) === "admin" ? "admin" : "user";

const roleOf = async (
  db: D1Database,
  userId: string,
): Promise<Result<FediRoleValue, RepositoryError>> => {
  const rows = await runD1(async () => {
    const result = await db.prepare(`SELECT role FROM "user" WHERE id = ?`).bind(userId).all();
    return parseRows(RoleRowSchema, result.results);
  });
  return rows.map((found) => roleFromAuthUser(found[0]?.role));
};

/**
 * The Better Auth user for this account. An account provisioned before the
 * link existed gets one now; a new account is created for the caller.
 */
const ensureUser = async (
  env: Env,
  identity: AccessIdentity,
  account: LocalAccount | undefined,
  username: string,
): Promise<Result<UserLink, RepositoryError>> => {
  const email = Sensitive.of(identity.email).reveal();
  if (account) {
    const linked = await linkedUserId(env.DB, account.id);
    if (linked.isErr()) {
      return err(linked.error);
    }
    if (linked.value) {
      return ok({ id: linked.value, created: false });
    }
  }
  const inserted = await insertUser(env.DB, {
    id: crypto.randomUUID(),
    username,
    email,
    role: createRole(env, identity, username),
    now: Date.now(),
  });
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  if (account) {
    const linked = await runD1(() =>
      runTyped(env.DB, setAccountAuthUser(account.id, inserted.value.id)),
    );
    if (linked.isErr()) {
      return err(linked.error);
    }
  }
  return ok(inserted.value);
};

const loadSession = async (
  db: D1Database,
  id: string,
): Promise<Result<SessionRow | undefined, RepositoryError>> => {
  const rows = await runD1(async () => {
    const result = await db
      .prepare(
        `SELECT id, token, createdAt, updatedAt, expiresAt, "userId" FROM "session" WHERE id = ?`,
      )
      .bind(id)
      .all();
    return parseRows(SessionRowSchema, result.results);
  });
  return rows.map((found) => found[0]);
};

const insertSession = async (
  db: D1Database,
  created: SessionRow,
): Promise<Result<SessionRow, RepositoryError>> => {
  const inserted = await runD1(() =>
    db
      .prepare(
        `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        created.id,
        created.expiresAt,
        created.token,
        created.createdAt,
        created.updatedAt,
        created.userId,
      )
      .run(),
  );
  return inserted.map(() => created);
};

/** The web token's id is the session id, so a reused session would keep the old account. */
const dropSession = async (db: D1Database, id: string): Promise<Result<void, RepositoryError>> => {
  const tokens = await runD1(() =>
    db
      .prepare(`DELETE FROM oauth_access_tokens WHERE id = ? OR web_session_id = ?`)
      .bind(`web:${id}`, id)
      .run(),
  );
  if (tokens.isErr()) {
    return err(tokens.error);
  }
  const deleted = await runD1(() =>
    db.prepare(`DELETE FROM "session" WHERE id = ?`).bind(id).run(),
  );
  return deleted.map(() => undefined);
};

const freshSession = (id: string, userId: string, identity: AccessIdentity): SessionRow => ({
  id,
  token: crypto.randomUUID(),
  createdAt: identity.issuedAtMs,
  updatedAt: identity.issuedAtMs,
  expiresAt: identity.expiresAtMs,
  userId,
});

/**
 * One session per Access subject. `createdAt` is when this Access login
 * started (`iat`). A newer `iat` is a new Access login; an older stored
 * `createdAt` stays, so a page can still require a recent sign-in. A row
 * whose user is not this account is deleted and written again, which also
 * drops the web token that `INSERT OR IGNORE` would otherwise keep.
 */
const touchSession = async (
  db: D1Database,
  row: SessionRow,
  identity: AccessIdentity,
): Promise<Result<SessionRow, RepositoryError>> => {
  const freshLogin = identity.issuedAtMs > row.updatedAt;
  const next = {
    createdAt: freshLogin ? identity.issuedAtMs : row.createdAt,
    updatedAt: freshLogin ? identity.issuedAtMs : row.updatedAt,
    expiresAt: Math.max(row.expiresAt, identity.expiresAtMs),
  };
  if (
    next.createdAt === row.createdAt &&
    next.updatedAt === row.updatedAt &&
    next.expiresAt === row.expiresAt
  ) {
    return ok(row);
  }
  const updated = await runD1(() =>
    db
      .prepare(`UPDATE "session" SET createdAt = ?, updatedAt = ?, expiresAt = ? WHERE id = ?`)
      .bind(next.createdAt, next.updatedAt, next.expiresAt, row.id)
      .run(),
  );
  return updated.map(() => ({ ...row, ...next }));
};

const replaceSession = async (
  db: D1Database,
  identity: AccessIdentity,
  userId: string,
): Promise<Result<SessionRow, RepositoryError>> => {
  const id = await sessionIdFor(identity.sub);
  const dropped = await dropSession(db, id);
  if (dropped.isErr()) {
    return err(dropped.error);
  }
  const created = await insertSession(db, freshSession(id, userId, identity));
  if (created.isOk()) {
    return created;
  }
  const raced = await loadSession(db, id);
  if (raced.isErr()) {
    return err(raced.error);
  }
  return raced.value?.userId === userId
    ? touchSession(db, raced.value, identity)
    : err(created.error);
};

const ensureSession = async (
  db: D1Database,
  userId: string,
  identity: AccessIdentity,
): Promise<Result<SessionRow, RepositoryError>> => {
  const id = await sessionIdFor(identity.sub);
  const existing = await loadSession(db, id);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const row = existing.value;
  if (!row) {
    const created = await insertSession(db, freshSession(id, userId, identity));
    if (created.isOk()) {
      return created;
    }
    const raced = await loadSession(db, id);
    if (raced.isErr()) {
      return err(raced.error);
    }
    if (!raced.value) {
      return err(created.error);
    }
    return raced.value.userId === userId
      ? touchSession(db, raced.value, identity)
      : replaceSession(db, identity, userId);
  }
  return row.userId === userId
    ? touchSession(db, row, identity)
    : replaceSession(db, identity, userId);
};

const accountForIdentity = async (
  env: Env,
  identity: AccessIdentity,
  provision: boolean,
  request: Request,
): Promise<Result<ResolvedAccount, RepositoryError | { kind: "NoAccount" }>> => {
  const existing = await findAccountByEmail(env.DB, Sensitive.of(identity.email));
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value) {
    return ok({ account: existing.value, userCreated: false });
  }
  if (!provision || !registrationsOpen(env)) {
    return err({ kind: "NoAccount" });
  }
  // IP blocks: `sign_up_block` refuses the account, `sign_up_requires_approval`
  // holds it for an admin even when registrations are open to all.
  const ipDecision = await ipSignUpDecision(request, env);
  if (ipDecision.kind === "Blocked") {
    return err({ kind: "NoAccount" });
  }
  const pending = registrationApprovalRequired(env) || ipDecision.kind === "RequiresApproval";
  const base = Username.deriveFromEmail(identity.email, false);
  const suffixed = Username.deriveFromEmail(identity.email, true);
  const preferred = base.isOk() ? base.value : undefined;
  const username = preferred
    ? signupUsername(preferred)
    : err({ kind: "InvalidUsername" as const });
  if (username.isErr()) {
    return err({ kind: "NoAccount" });
  }
  const user = await ensureUser(env, identity, undefined, username.value);
  if (user.isErr()) {
    return err(user.error);
  }
  const created = await provisionLocalAccount(env.DB, {
    username: username.value,
    email: Sensitive.of(identity.email),
    authUserId: user.value.id,
    pending,
  });
  if (created.isErr()) {
    let failure: ProvisionError = created.error;
    if (created.error.kind === "UsernameTaken" && suffixed.isOk()) {
      const retryName = signupUsername(suffixed.value);
      if (retryName.isOk()) {
        const retried = await provisionLocalAccount(env.DB, {
          username: retryName.value,
          email: Sensitive.of(identity.email),
          authUserId: user.value.id,
          pending,
        });
        if (retried.isOk()) {
          await recordSignUpIp(env.DB, retried.value.id, request);
          await notifyAdmins(env, { kind: "admin.sign_up", fromAccountId: retried.value.id });
          return ok({ account: retried.value, userCreated: user.value.created });
        }
        failure = retried.error;
      }
    }
    if (user.value.created) {
      await runD1(() =>
        env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(user.value.id).run(),
      );
    }
    if (
      failure.kind === "RegistrationBlocked" ||
      failure.kind === "UsernameTaken" ||
      failure.kind === "InvalidUsername"
    ) {
      return err({ kind: "NoAccount" });
    }
    return err(failure);
  }
  await recordSignUpIp(env.DB, created.value.id, request);
  await notifyAdmins(env, { kind: "admin.sign_up", fromAccountId: created.value.id });
  return ok({ account: created.value, userCreated: user.value.created });
};

/**
 * The browser session for this request, from its Access JWT. No assertion is
 * signed out. A JWT that does not verify is signed out too: API calls use
 * OAuth bearer tokens, not this header. Only a login door provisions an account.
 */
export const accessLogin = async (
  request: Request,
  env: Env,
  options?: Readonly<{ provision?: boolean }>,
): Promise<AccessLogin> => {
  const assertion = accessAssertion(request);
  if (!assertion) {
    return { kind: "None" };
  }
  const identity = await accessIdentity(assertion, env, new URL(request.url).hostname);
  if (identity.isErr()) {
    return { kind: "None" };
  }
  const found = await accountForIdentity(env, identity.value, options?.provision === true, request);
  if (found.isErr()) {
    return { kind: "NoAccount" };
  }
  const user = await ensureUser(
    env,
    identity.value,
    found.value.account,
    found.value.account.username,
  );
  if (user.isErr()) {
    return { kind: "NoAccount" };
  }
  if (!found.value.userCreated && !user.value.created) {
    const synced = await syncAdminRole(env, identity.value, user.value.id);
    if (synced.isErr()) {
      return { kind: "NoAccount" };
    }
  }
  const moderation = await findLocalAccountModeration(env.DB, found.value.account.id);
  if (moderation.isOk() && LocalAccountModeration.isBarred(moderation.value)) {
    return { kind: "Barred" };
  }
  const session = await ensureSession(env.DB, user.value.id, identity.value);
  if (session.isErr()) {
    return { kind: "NoAccount" };
  }
  const role = await roleOf(env.DB, user.value.id);
  await recordAccountActivity(env.DB, found.value.account.id, request);
  return {
    kind: "Account",
    account: found.value.account,
    role: role.isOk() ? role.value : FediRole.User,
    signedInAt: new Date(session.value.createdAt),
    userId: user.value.id,
    sessionId: session.value.id,
    sessionToken: session.value.token,
  };
};

/** Drop the local session for this Access identity. The browser still has to leave Access. */
export const endAccessSessions = async (request: Request, env: Env): Promise<void> => {
  const assertion = accessAssertion(request);
  if (!assertion) {
    return;
  }
  const identity = await accessIdentity(assertion, env, new URL(request.url).hostname);
  if (identity.isErr()) {
    return;
  }
  const account = await findAccountByEmail(env.DB, Sensitive.of(identity.value.email));
  if (account.isErr() || !account.value) {
    return;
  }
  const userId = await linkedUserId(env.DB, account.value.id);
  if (userId.isErr() || !userId.value) {
    return;
  }
  await runD1(() =>
    env.DB.prepare(`DELETE FROM "session" WHERE "userId" = ?`).bind(userId.value).run(),
  );
};
