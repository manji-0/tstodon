import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { provisionAccountFromEmail } from "./account-store";
import { FediRole, type FediRole as FediRoleValue, type LocalAccount } from "@tstodon/domain";
import type { RepositoryError } from "./d1";
import {
  JoseErrorCodeSchema,
  WorkOsAccessTokenSchema,
  WorkOsUserSchema,
} from "./schemas";

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

const jwksByClientId = new Map<string, JWTVerifyGetKey>();

const workOsJwks = (clientId: string): JWTVerifyGetKey => {
  const cached = jwksByClientId.get(clientId);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(
    new URL(`https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`),
  );
  jwksByClientId.set(clientId, jwks);
  return jwks;
};

const authErrorFromJose = (cause: unknown): AuthError => {
  const parsed = schemaResult(JoseErrorCodeSchema)(cause);
  if (parsed.isOk() && parsed.value.code === "ERR_JWKS_TIMEOUT") {
    return { kind: "VerificationUnavailable" };
  }
  return { kind: "InvalidToken" };
};

const parseDevBearer = (
  rest: string,
): Result<{ email: string; role: FediRoleValue }, AuthError> => {
  if (rest.length === 0) {
    return err({ kind: "InvalidToken" });
  }
  const separator = rest.lastIndexOf(":");
  if (separator === -1) {
    return ok({ email: rest, role: FediRole.User });
  }
  const email = rest.slice(0, separator);
  const suffix = rest.slice(separator + 1);
  if (email.length === 0) {
    return err({ kind: "InvalidToken" });
  }
  const name = schemaResult(FediRole.nameSchema)(suffix);
  if (name.isErr()) {
    return err({ kind: "InvalidToken" });
  }
  return ok({ email, role: FediRole.fromName(name.value) });
};

const roleFromAccessToken = (claims: {
  "fedi/role"?: string | undefined;
  fedi?: Readonly<Record<string, unknown>> | undefined;
}): FediRoleValue => {
  const direct = claims["fedi/role"];
  if (typeof direct === "string") {
    return FediRole.fromName(direct);
  }
  return FediRole.fromMetadata(claims.fedi);
};

const hasRoleClaim = (claims: {
  "fedi/role"?: string | undefined;
  fedi?: Readonly<Record<string, unknown>> | undefined;
}): boolean =>
  typeof claims["fedi/role"] === "string" || claims.fedi !== undefined;

const identityFromWorkOsUser = async (
  userId: string,
  apiKey: string,
): Promise<Result<{ email: string; role: FediRoleValue }, AuthError>> => {
  try {
    const response = await fetch(
      `https://api.workos.com/user_management/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    if (response.status >= 500) {
      return err({ kind: "VerificationUnavailable" });
    }
    if (!response.ok) {
      return err({ kind: "InvalidToken" });
    }
    const parsed = schemaResult(WorkOsUserSchema)(await response.json());
    if (parsed.isErr()) {
      return err({ kind: "InvalidToken" });
    }
    return ok({
      email: parsed.value.email,
      role: FediRole.fromMetadata(parsed.value.metadata),
    });
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

const identityFromWorkOsToken = async (
  token: string,
  env: Env,
): Promise<Result<{ email: string; role: FediRoleValue }, AuthError>> => {
  const clientId = `${env.WORKOS_CLIENT_ID}`;
  if (clientId.length === 0) {
    return err({ kind: "InvalidToken" });
  }
  try {
    const issuer = `${env.WORKOS_ISSUER}` || "https://api.workos.com";
    const options: Parameters<typeof jwtVerify>[2] = {
      issuer,
      clockTolerance: 5,
    };
    const audience = `${env.WORKOS_AUDIENCE}`;
    if (audience.length > 0) {
      options.audience = audience;
    }
    const verified = await jwtVerify(token, workOsJwks(clientId), options);
    const claims = schemaResult(WorkOsAccessTokenSchema)(verified.payload);
    if (claims.isErr()) {
      return err({ kind: "InvalidToken" });
    }
    if (claims.value.client_id && claims.value.client_id !== clientId) {
      return err({ kind: "InvalidToken" });
    }
    const role = roleFromAccessToken(claims.value);
    if (claims.value.email) {
      return ok({ email: claims.value.email, role });
    }
    const apiKey = `${env.WORKOS_API_KEY}`;
    if (apiKey.length === 0) {
      return err({ kind: "InvalidToken" });
    }
    const lookedUp = await identityFromWorkOsUser(claims.value.sub, apiKey);
    if (lookedUp.isErr()) {
      return err(lookedUp.error);
    }
    return ok({
      email: lookedUp.value.email,
      role: hasRoleClaim(claims.value) ? role : lookedUp.value.role,
    });
  } catch (cause) {
    return err(authErrorFromJose(cause));
  }
};

export const authenticate = async (
  request: Request,
  env: Env,
): Promise<Result<AuthContext, AuthError>> => {
  const token = bearerToken(request);
  if (!token) {
    return ok({ kind: "Anonymous" });
  }
  const secret = env.DEV_BEARER_SECRET;
  if (secret && token.startsWith(`${secret}:`)) {
    const parsed = parseDevBearer(token.slice(secret.length + 1));
    if (parsed.isErr()) {
      return err(parsed.error);
    }
    const account = await provisionAccountFromEmail(env.DB, parsed.value.email);
    if (account.isErr()) {
      return err(account.error);
    }
    return ok({
      kind: "Account",
      account: account.value,
      role: parsed.value.role,
    });
  }
  if (`${env.WORKOS_CLIENT_ID}`.length > 0) {
    const identity = await identityFromWorkOsToken(token, env);
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
  }
  return err({ kind: "InvalidToken" });
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
