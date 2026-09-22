import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { provisionAccountFromEmail } from "./account-store";
import { FediRole, type FediRole as FediRoleValue, type LocalAccount } from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import { AccessJwksSchema, AccessJwtSchema, JoseErrorCodeSchema } from "./schemas";

export type AuthError =
  | Readonly<{ kind: "MissingToken" }>
  | Readonly<{ kind: "InvalidToken" }>
  | Readonly<{ kind: "VerificationUnavailable" }>
  | Readonly<{ kind: "Forbidden" }>
  | RepositoryError;

export type AuthContext =
  | Readonly<{ kind: "Anonymous" }>
  | Readonly<{ kind: "Account"; account: LocalAccount; role: FediRoleValue }>;

export type AuthenticatedSession = Readonly<{
  account: LocalAccount;
  role: FediRoleValue;
}>;

const bearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  return header.slice("bearer ".length).trim();
};

const accessTokenFromRequest = (request: Request): string | undefined => {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (assertion && assertion.length > 0) {
    return assertion;
  }
  return bearerToken(request);
};

const jwksByKey = new Map<string, JWTVerifyGetKey>();

const parseAdminGroups = (raw: string): ReadonlySet<string> =>
  new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );

const groupsFromClaims = (claims: {
  groups?: ReadonlyArray<string> | undefined;
  custom?: Readonly<Record<string, unknown>> | undefined;
}): ReadonlyArray<string> => {
  const fromTop = claims.groups ?? [];
  const customGroups = claims.custom?.groups;
  const fromCustom = Array.isArray(customGroups)
    ? customGroups.filter((value): value is string => typeof value === "string")
    : [];
  return [...fromTop, ...fromCustom];
};

const roleFromAccessClaims = (
  claims: {
    groups?: ReadonlyArray<string> | undefined;
    custom?: Readonly<Record<string, unknown>> | undefined;
  },
  adminGroups: ReadonlySet<string>,
): FediRoleValue => {
  if (adminGroups.size === 0) {
    return FediRole.User;
  }
  for (const group of groupsFromClaims(claims)) {
    if (adminGroups.has(group.trim().toLowerCase())) {
      return FediRole.Admin;
    }
  }
  return FediRole.User;
};

const accessJwks = (env: Env): Result<JWTVerifyGetKey, AuthError> => {
  const inline = `${env.CF_ACCESS_JWKS_JSON ?? ""}`;
  if (inline.length > 0) {
    const cacheKey = `json:${inline}`;
    const cached = jwksByKey.get(cacheKey);
    if (cached) {
      return ok(cached);
    }
    try {
      const raw: unknown = JSON.parse(inline);
      const parsed = schemaResult(AccessJwksSchema)(raw);
      if (parsed.isErr()) {
        return err({ kind: "VerificationUnavailable" });
      }
      // Re-parse so jose receives a JSONWebKeySet without exactOptionalPropertyTypes friction.
      const jwks = createLocalJWKSet(JSON.parse(inline));
      jwksByKey.set(cacheKey, jwks);
      return ok(jwks);
    } catch {
      return err({ kind: "VerificationUnavailable" });
    }
  }

  const override = `${env.CF_ACCESS_JWKS_URL ?? ""}`.trim();
  const teamDomain = `${env.CF_ACCESS_TEAM_DOMAIN}`.replace(/\/$/, "");
  const url =
    override.length > 0
      ? override
      : teamDomain.length > 0
        ? `${teamDomain}/cdn-cgi/access/certs`
        : "";
  if (url.length === 0) {
    return err({ kind: "InvalidToken" });
  }
  const cached = jwksByKey.get(url);
  if (cached) {
    return ok(cached);
  }
  const jwks = createRemoteJWKSet(new URL(url));
  jwksByKey.set(url, jwks);
  return ok(jwks);
};

const authErrorFromJose = (cause: unknown): AuthError => {
  const parsed = schemaResult(JoseErrorCodeSchema)(cause);
  if (parsed.isOk() && parsed.value.code === "ERR_JWKS_TIMEOUT") {
    return { kind: "VerificationUnavailable" };
  }
  return { kind: "InvalidToken" };
};

const identityFromAccessToken = async (
  token: string,
  env: Env,
): Promise<Result<{ email: string; role: FediRoleValue }, AuthError>> => {
  const teamDomain = `${env.CF_ACCESS_TEAM_DOMAIN}`.replace(/\/$/, "");
  const audience = `${env.CF_ACCESS_AUD}`.trim();
  if (teamDomain.length === 0 || audience.length === 0) {
    return err({ kind: "InvalidToken" });
  }
  const jwks = accessJwks(env);
  if (jwks.isErr()) {
    return err(jwks.error);
  }
  try {
    const verified = await jwtVerify(token, jwks.value, {
      issuer: teamDomain,
      audience,
      clockTolerance: 5,
    });
    const claims = schemaResult(AccessJwtSchema)(verified.payload);
    if (claims.isErr() || !claims.value.email) {
      return err({ kind: "InvalidToken" });
    }
    return ok({
      email: claims.value.email,
      role: roleFromAccessClaims(claims.value, parseAdminGroups(`${env.CF_ACCESS_ADMIN_GROUPS}`)),
    });
  } catch (cause) {
    return err(authErrorFromJose(cause));
  }
};

export const authenticate = async (
  request: Request,
  env: Env,
): Promise<Result<AuthContext, AuthError>> => {
  const token = accessTokenFromRequest(request);
  if (!token) {
    return ok({ kind: "Anonymous" });
  }
  const identity = await identityFromAccessToken(token, env);
  if (identity.isErr()) {
    return err(identity.error);
  }
  const account = await provisionAccountFromEmail(env.DB, identity.value.email);
  if (account.isErr()) {
    return err(account.error);
  }
  return ok({
    kind: "Account",
    account: account.value,
    role: identity.value.role,
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
    return err({ kind: "MissingToken" });
  }
  return ok({ account: auth.value.account, role: auth.value.role });
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
