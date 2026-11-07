import { schemaResult, warmSchemas } from "@tstodon/core";
import { AccessEmail, type AccessEmail as AccessEmailValue } from "@tstodon/domain";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { optionalEnvString } from "./runtime-config";

/**
 * Cloudflare Access is the login. The Worker never registers a passkey: Access
 * (its own passkeys, or an identity provider such as WorkOS) authenticates the
 * browser and sends `Cf-Access-Jwt-Assertion`. This module checks that JWT.
 */

const JoseErrorCodeSchema = z.object({
  code: z.string().min(1),
});

const JsonWebKeySchema = z
  .object({
    kty: z.string().min(1),
    kid: z.string().optional(),
    alg: z.string().optional(),
    use: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .loose();

const AccessJwksSchema = z.object({
  keys: z.array(JsonWebKeySchema).min(1),
});

const AccessJwtClaimsSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().min(1).optional(),
    iat: z.number(),
    exp: z.number(),
    groups: z.array(z.string()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const copyJwkField = (jwk: JWK, field: "kid" | "n" | "e", value: string | undefined): void => {
  if (value !== undefined) {
    jwk[field] = value;
  }
};

/**
 * RSA keys only. Access signs with RS256; other `kty` values in a pasted JWKS
 * are ignored so they cannot verify a token.
 */
const accessJwk = (key: z.infer<typeof JsonWebKeySchema>): JWK | undefined => {
  if (key.kty !== "RSA" || (key.alg !== undefined && key.alg !== "RS256")) {
    return undefined;
  }
  const jwk: JWK = { kty: "RSA" };
  copyJwkField(jwk, "kid", key.kid);
  copyJwkField(jwk, "n", key.n);
  copyJwkField(jwk, "e", key.e);
  if (key.use === "sig" || key.use === "enc") {
    jwk.use = key.use;
  }
  if (key.alg === "RS256") {
    jwk.alg = "RS256";
  }
  return jwk;
};

/** Published in the test fixture. A production host must not accept it. */
const LOCAL_ACCESS_KID = "tstodon-local-access";

/** Same hosts Void treats as local, plus IPv6 loopback. */
const isLocalAccessHost = (hostname: string): boolean => {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
};

/** Issuer, with surrounding whitespace and a trailing slash removed. */
const accessTeamDomain = (env: Env): string =>
  optionalEnvString(env, "CF_ACCESS_TEAM_DOMAIN").trim().replace(/\/+$/, "");

const parseJoseErrorCode = schemaResult(JoseErrorCodeSchema);
const parseAccessJwks = schemaResult(AccessJwksSchema);
const parseAccessJwtClaims = schemaResult(AccessJwtClaimsSchema);

warmSchemas([JoseErrorCodeSchema, JsonWebKeySchema, AccessJwksSchema, AccessJwtClaimsSchema]);

export type AccessJwtError =
  | Readonly<{ kind: "NotConfigured" }>
  | Readonly<{ kind: "InvalidToken" }>
  | Readonly<{ kind: "VerificationUnavailable" }>;

/** Who Access says this request is, after the signature and audience check. */
export type AccessIdentity = Readonly<{
  email: AccessEmailValue;
  sub: string;
  /** `iat`, in milliseconds. */
  issuedAtMs: number;
  /** `exp`, in milliseconds. */
  expiresAtMs: number;
  groups: ReadonlyArray<string>;
}>;

export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

/** The assertion Access attaches. An `Authorization` bearer is an OAuth token, not this. */
export const accessAssertion = (request: Request): string | undefined => {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  return assertion && assertion.length > 0 ? assertion : undefined;
};

const jwksByKey = new Map<string, JWTVerifyGetKey>();

const authErrorFromJose = (cause: unknown): AccessJwtError => {
  const parsed = parseJoseErrorCode(cause);
  if (parsed.isOk() && parsed.value.code === "ERR_JWKS_TIMEOUT") {
    return { kind: "VerificationUnavailable" };
  }
  return { kind: "InvalidToken" };
};

const groupsFromClaims = (claims: z.infer<typeof AccessJwtClaimsSchema>): ReadonlyArray<string> => {
  const customGroups = claims.custom?.groups;
  const fromCustom = Array.isArray(customGroups)
    ? customGroups.filter((value): value is string => typeof value === "string")
    : [];
  return [...(claims.groups ?? []), ...fromCustom];
};

const accessJwks = (env: Env): Result<JWTVerifyGetKey, AccessJwtError> => {
  const inline = optionalEnvString(env, "CF_ACCESS_JWKS_JSON").trim();
  if (inline.length > 0) {
    const cacheKey = `json:${inline}`;
    const cached = jwksByKey.get(cacheKey);
    if (cached) {
      return ok(cached);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(inline);
    } catch {
      return err({ kind: "VerificationUnavailable" });
    }
    const parsed = parseAccessJwks(raw);
    if (parsed.isErr()) {
      return err({ kind: "VerificationUnavailable" });
    }
    const keys = parsed.value.keys.flatMap((key) => {
      const jwk = accessJwk(key);
      return jwk === undefined ? [] : [jwk];
    });
    if (keys.length === 0) {
      return err({ kind: "VerificationUnavailable" });
    }
    try {
      const jwks = createLocalJWKSet({ keys });
      jwksByKey.set(cacheKey, jwks);
      return ok(jwks);
    } catch {
      return err({ kind: "VerificationUnavailable" });
    }
  }

  const override = optionalEnvString(env, "CF_ACCESS_JWKS_URL").trim();
  const teamDomain = accessTeamDomain(env);
  const url =
    override.length > 0
      ? override
      : teamDomain.length > 0
        ? `${teamDomain}/cdn-cgi/access/certs`
        : "";
  if (url.length === 0) {
    return err({ kind: "NotConfigured" });
  }
  const cached = jwksByKey.get(url);
  if (cached) {
    return ok(cached);
  }
  const jwks = createRemoteJWKSet(new URL(url));
  jwksByKey.set(url, jwks);
  return ok(jwks);
};

/** Whether this Worker has the issuer and audience it needs to trust Access. */
export const accessConfigured = (env: Env): boolean =>
  accessTeamDomain(env).length > 0 && optionalEnvString(env, "CF_ACCESS_AUD").trim().length > 0;

/**
 * Verify an Access JWT. `CF_ACCESS_TEAM_DOMAIN` is the issuer
 * (`https://<team>.cloudflareaccess.com`), `CF_ACCESS_AUD` is the application
 * audience tag, and the keys come from `CF_ACCESS_JWKS_JSON`,
 * `CF_ACCESS_JWKS_URL`, or the team's `/cdn-cgi/access/certs`.
 */
export const accessIdentity = async (
  token: string,
  env: Env,
  hostname: string,
): Promise<Result<AccessIdentity, AccessJwtError>> => {
  const teamDomain = accessTeamDomain(env);
  const audience = optionalEnvString(env, "CF_ACCESS_AUD").trim();
  if (teamDomain.length === 0 || audience.length === 0) {
    return err({ kind: "NotConfigured" });
  }
  const jwks = accessJwks(env);
  if (jwks.isErr()) {
    return err(jwks.error);
  }
  try {
    const verified = await jwtVerify(token, jwks.value, {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    if (verified.protectedHeader.kid === LOCAL_ACCESS_KID && !isLocalAccessHost(hostname)) {
      return err({ kind: "InvalidToken" });
    }
    const claims = parseAccessJwtClaims(verified.payload);
    if (claims.isErr() || claims.value.email === undefined) {
      return err({ kind: "InvalidToken" });
    }
    const email = AccessEmail.parse(claims.value.email);
    if (email.isErr()) {
      return err({ kind: "InvalidToken" });
    }
    return ok({
      email: email.value,
      sub: claims.value.sub,
      issuedAtMs: claims.value.iat * 1000,
      expiresAtMs: claims.value.exp * 1000,
      groups: groupsFromClaims(claims.value),
    });
  } catch (cause) {
    return err(authErrorFromJose(cause));
  }
};

/** Group names from `CF_ACCESS_ADMIN_GROUPS` that make the Access identity an admin. */
export const accessAdminGroups = (env: Env): ReadonlySet<string> =>
  new Set(
    optionalEnvString(env, "CF_ACCESS_ADMIN_GROUPS")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );

export const identityIsAccessAdmin = (identity: AccessIdentity, env: Env): boolean => {
  const admins = accessAdminGroups(env);
  if (admins.size === 0) {
    return false;
  }
  return identity.groups.some((group) => admins.has(group.trim().toLowerCase()));
};
