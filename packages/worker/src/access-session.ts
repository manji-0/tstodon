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
import { provisionLocalAccount, signupUsername } from "./account-provision";
import { findAccountByEmail } from "./account-store";
import {
  accessAssertion,
  accessIdentity,
  identityIsAccessAdmin,
  type AccessIdentity,
} from "./access-jwt";
import { notifyAdmins } from "./admin-notify";
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
});

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

/** `ADMIN_USERNAMES` bootstraps admins: those names are created as admins. */
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
): Promise<Result<string, RepositoryError>> => {
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
    return ok(input.id);
  }
  const existing = await userIdForEmail(db, input.email);
  if (existing.isErr()) {
    return err(existing.error);
  }
  return existing.value ? ok(existing.value) : err(inserted.error);
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
): Promise<Result<string, RepositoryError>> => {
  const email = Sensitive.of(identity.email).reveal();
  const role =
    signupRole(env, username) === "admin" || identityIsAccessAdmin(identity, env)
      ? "admin"
      : "user";
  if (account) {
    const linked = await linkedUserId(env.DB, account.id);
    if (linked.isErr()) {
      return err(linked.error);
    }
    if (linked.value) {
      if (role === "admin") {
        const promoted = await promoteAdmin(env.DB, linked.value);
        if (promoted.isErr()) {
          return err(promoted.error);
        }
      }
      return ok(linked.value);
    }
  }
  const now = Date.now();
  const userId = await insertUser(env.DB, {
    id: crypto.randomUUID(),
    username,
    email,
    role,
    now,
  });
  if (userId.isErr()) {
    return err(userId.error);
  }
  if (role === "admin") {
    const promoted = await promoteAdmin(env.DB, userId.value);
    if (promoted.isErr()) {
      return err(promoted.error);
    }
  }
  if (account) {
    const linked = await runD1(() =>
      runTyped(env.DB, setAccountAuthUser(account.id, userId.value)),
    );
    if (linked.isErr()) {
      return err(linked.error);
    }
  }
  return ok(userId.value);
};

const loadSession = async (
  db: D1Database,
  id: string,
): Promise<Result<z.infer<typeof SessionRowSchema> | undefined, RepositoryError>> => {
  const rows = await runD1(async () => {
    const result = await db
      .prepare(`SELECT id, token, createdAt, updatedAt, expiresAt FROM "session" WHERE id = ?`)
      .bind(id)
      .all();
    return parseRows(SessionRowSchema, result.results);
  });
  return rows.map((found) => found[0]);
};

/**
 * One session per Access subject. `createdAt` is when this Access login
 * started (`iat`). A newer `iat` is a new Access login; an older stored
 * `createdAt` stays, so a page can still require a recent sign-in.
 */
const ensureSession = async (
  db: D1Database,
  userId: string,
  identity: AccessIdentity,
): Promise<Result<z.infer<typeof SessionRowSchema>, RepositoryError>> => {
  const id = await sessionIdFor(identity.sub);
  const existing = await loadSession(db, id);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const row = existing.value;
  if (!row) {
    const created: z.infer<typeof SessionRowSchema> = {
      id,
      token: crypto.randomUUID(),
      createdAt: identity.issuedAtMs,
      updatedAt: identity.issuedAtMs,
      expiresAt: identity.expiresAtMs,
    };
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
          userId,
        )
        .run(),
    );
    if (inserted.isOk()) {
      return ok(created);
    }
    const raced = await loadSession(db, id);
    if (raced.isErr()) {
      return err(raced.error);
    }
    return raced.value ? ok(raced.value) : err(inserted.error);
  }
  const freshLogin = identity.issuedAtMs > row.updatedAt;
  const next = {
    createdAt: freshLogin ? identity.issuedAtMs : row.createdAt,
    updatedAt: freshLogin ? identity.issuedAtMs : row.updatedAt,
    expiresAt: Math.max(row.expiresAt, identity.expiresAtMs),
  };
  if (
    next.createdAt !== row.createdAt ||
    next.updatedAt !== row.updatedAt ||
    next.expiresAt !== row.expiresAt
  ) {
    const updated = await runD1(() =>
      db
        .prepare(`UPDATE "session" SET createdAt = ?, updatedAt = ?, expiresAt = ? WHERE id = ?`)
        .bind(next.createdAt, next.updatedAt, next.expiresAt, id)
        .run(),
    );
    if (updated.isErr()) {
      return err(updated.error);
    }
  }
  return ok({ ...row, ...next });
};

const accountForIdentity = async (
  env: Env,
  identity: AccessIdentity,
): Promise<Result<LocalAccount | undefined, RepositoryError | { kind: "NoAccount" }>> => {
  const existing = await findAccountByEmail(env.DB, Sensitive.of(identity.email));
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value) {
    return ok(existing.value);
  }
  if (!registrationsOpen(env)) {
    return err({ kind: "NoAccount" });
  }
  const base = Username.deriveFromEmail(identity.email, false);
  const suffixed = Username.deriveFromEmail(identity.email, true);
  const preferred = base.isOk() ? base.value : undefined;
  const username = preferred
    ? signupUsername(preferred)
    : err({ kind: "InvalidUsername" as const });
  if (username.isErr()) {
    return err({ kind: "NoAccount" });
  }
  const taken = await findAccountByEmail(env.DB, Sensitive.of(identity.email));
  if (taken.isErr()) {
    return err(taken.error);
  }
  if (taken.value) {
    return ok(taken.value);
  }
  const userId = await ensureUser(env, identity, undefined, username.value);
  if (userId.isErr()) {
    return err(userId.error);
  }
  const created = await provisionLocalAccount(env.DB, {
    username: username.value,
    email: Sensitive.of(identity.email),
    authUserId: userId.value,
    pending: registrationApprovalRequired(env),
  });
  if (created.isErr()) {
    if (created.error.kind === "UsernameTaken" && suffixed.isOk()) {
      const retryName = signupUsername(suffixed.value);
      if (retryName.isOk()) {
        const retried = await provisionLocalAccount(env.DB, {
          username: retryName.value,
          email: Sensitive.of(identity.email),
          authUserId: userId.value,
          pending: registrationApprovalRequired(env),
        });
        if (retried.isOk()) {
          await notifyAdmins(env, { kind: "admin.sign_up", fromAccountId: retried.value.id });
          return ok(retried.value);
        }
      }
    }
    await runD1(() => env.DB.prepare(`DELETE FROM "user" WHERE id = ?`).bind(userId.value).run());
    if (
      created.error.kind === "RegistrationBlocked" ||
      created.error.kind === "UsernameTaken" ||
      created.error.kind === "InvalidUsername"
    ) {
      return err({ kind: "NoAccount" });
    }
    return err(created.error);
  }
  await notifyAdmins(env, { kind: "admin.sign_up", fromAccountId: created.value.id });
  return ok(created.value);
};

/**
 * The browser session for this request, from its Access JWT. No assertion is
 * signed out. A JWT that does not verify is signed out too: API calls use
 * OAuth bearer tokens, not this header.
 */
export const accessLogin = async (request: Request, env: Env): Promise<AccessLogin> => {
  const assertion = accessAssertion(request);
  if (!assertion) {
    return { kind: "None" };
  }
  const identity = await accessIdentity(assertion, env);
  if (identity.isErr()) {
    return { kind: "None" };
  }
  const account = await accountForIdentity(env, identity.value);
  if (account.isErr()) {
    return { kind: "NoAccount" };
  }
  if (!account.value) {
    return { kind: "NoAccount" };
  }
  const userId = await ensureUser(env, identity.value, account.value, account.value.username);
  if (userId.isErr()) {
    return { kind: "NoAccount" };
  }
  const moderation = await findLocalAccountModeration(env.DB, account.value.id);
  if (moderation.isOk() && LocalAccountModeration.isBarred(moderation.value)) {
    return { kind: "Barred" };
  }
  const session = await ensureSession(env.DB, userId.value, identity.value);
  if (session.isErr()) {
    return { kind: "NoAccount" };
  }
  const role = await roleOf(env.DB, userId.value);
  return {
    kind: "Account",
    account: account.value,
    role: role.isOk() ? role.value : FediRole.User,
    signedInAt: new Date(session.value.createdAt),
    userId: userId.value,
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
  const identity = await accessIdentity(assertion, env);
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
