import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { FediRole, type FediRole as FediRoleValue, type LocalAccount } from "@tstodon/domain";
import { accountFromRow, AccountRowSchema } from "./account-store";
import { parseRow, runD1, type RepositoryError } from "./d1";
import { findAccessTokenAccount } from "./generated/prisma/sql";
import { requiredScope, scopeAllows } from "./oauth-scope";
import { sha256Hex } from "./oauth-store";
import { queryTyped } from "./typed-sql";

export type AuthError =
  | Readonly<{ kind: "MissingToken" }>
  | Readonly<{ kind: "InvalidToken" }>
  | Readonly<{ kind: "VerificationUnavailable" }>
  | Readonly<{ kind: "Forbidden" }>
  | Readonly<{ kind: "InsufficientScope" }>
  | RepositoryError;

/** The OAuth access token a request presented. */
export type AccessToken = Readonly<{
  id: string;
  applicationId: string;
  scopes: ReadonlyArray<string>;
}>;

export type AuthContext =
  | Readonly<{ kind: "Anonymous" }>
  /** A client_credentials token: the app, acting for no one. */
  | Readonly<{ kind: "Application"; token: AccessToken }>
  | Readonly<{ kind: "Account"; account: LocalAccount; role: FediRoleValue; token: AccessToken }>;

export type AuthenticatedSession = Readonly<{
  account: LocalAccount;
  role: FediRoleValue;
  token: AccessToken;
}>;

export const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("Authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice("bearer ".length).trim();
    return token.length > 0 ? token : undefined;
  }
  // A browser WebSocket cannot set headers, so streaming clients pass the
  // token as `access_token` or as the WebSocket subprotocol, both of which
  // Mastodon's streaming server accepts.
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/v1/streaming")) {
    const token =
      url.searchParams.get("access_token")?.trim() ||
      request.headers.get("Sec-WebSocket-Protocol")?.trim();
    return token && token.length > 0 ? token : undefined;
  }
  return undefined;
};

const TokenRowSchema = z.object({
  token_id: z.string(),
  application_id: z.string(),
  scopes: z.string(),
  account_id: z.string().nullable(),
  auth_role: z.string().nullable(),
  moderation: z.string().nullable(),
  disabled: z.number(),
  web_session_id: z.string().nullable(),
  web_session_expires_at: z.number().nullable(),
});

/** Better Auth's admin plugin stores roles comma-separated. */
const roleFromAuthUser = (role: string | null): FediRoleValue =>
  (role ?? "")
    .split(",")
    .map((name) => name.trim())
    .includes("admin")
    ? FediRole.Admin
    : FediRole.User;

/**
 * Who a request acts as, from its `Authorization: Bearer` OAuth token. The
 * token must carry a scope for the request's method and path; suspended and
 * disabled accounts are refused.
 */
export const authenticate = async (
  request: Request,
  env: Env,
): Promise<Result<AuthContext, AuthError>> => {
  const presented = bearerToken(request);
  if (!presented) {
    return ok({ kind: "Anonymous" });
  }
  const rows = await runD1(async () =>
    queryTyped(env.DB, findAccessTokenAccount(await sha256Hex(presented))),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const raw = rows.value[0];
  if (raw === undefined) {
    return err({ kind: "InvalidToken" });
  }
  const row = parseRow(TokenRowSchema, raw);
  if (row.isErr()) {
    return err(row.error);
  }
  if (row.value.web_session_id !== null && (row.value.web_session_expires_at ?? 0) <= Date.now()) {
    // The web app's token lives only as long as its Better Auth session.
    return err({ kind: "InvalidToken" });
  }
  const token: AccessToken = {
    id: row.value.token_id,
    applicationId: row.value.application_id,
    scopes: row.value.scopes.split(" ").filter((scope) => scope.length > 0),
  };
  const path = new URL(request.url).pathname;
  if (!scopeAllows(token.scopes, requiredScope(request.method, path), path)) {
    return err({ kind: "InsufficientScope" });
  }
  if (row.value.account_id === null) {
    return ok({ kind: "Application", token });
  }
  const accountRow = parseRow(AccountRowSchema, raw).andThen(accountFromRow);
  if (accountRow.isErr()) {
    return err(accountRow.error);
  }
  if (row.value.moderation === "Suspended" || row.value.disabled !== 0) {
    // Mastodon's `disable` action blocks the login while the profile stays.
    return err({ kind: "Forbidden" });
  }
  return ok({
    kind: "Account",
    account: accountRow.value,
    role: roleFromAuthUser(row.value.auth_role),
    token,
  });
};

export const requireSession = async (
  request: Request,
  env: Env,
): Promise<Result<AuthenticatedSession, AuthError>> => {
  const auth = await authenticate(request, env);
  if (auth.isErr()) {
    return err(auth.error);
  }
  if (auth.value.kind !== "Account") {
    // An app-only token, like no token, has no user to act for.
    return err({ kind: "MissingToken" });
  }
  return ok({ account: auth.value.account, role: auth.value.role, token: auth.value.token });
};

export const requireAccount = async (
  request: Request,
  env: Env,
): Promise<Result<LocalAccount, AuthError>> => {
  const session = await requireSession(request, env);
  if (session.isErr()) {
    return err(session.error);
  }
  return ok(session.value.account);
};

export const requireAdmin = async (
  request: Request,
  env: Env,
): Promise<Result<AuthenticatedSession, AuthError>> => {
  const session = await requireSession(request, env);
  if (session.isErr()) {
    return err(session.error);
  }
  if (!FediRole.isAdmin(session.value.role)) {
    return err({ kind: "Forbidden" });
  }
  return ok(session.value);
};
