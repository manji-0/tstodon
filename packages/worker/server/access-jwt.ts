import { schemaResult, warmSchemas } from "@tstodon/core";
import { AccessEmail, type AccessEmail as AccessEmailValue } from "@tstodon/domain";
import { createLocalJWKSet, jwtVerify, type JWK, type JWTVerifyGetKey } from "jose";
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

/**
 * Same hosts Void treats as local, plus IPv6 loopback and `*.localhost`
 * (RFC 6761 loopback names, e.g. the portless e2e pair).
 */
const isLocalAccessHost = (hostname: string): boolean => {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  );
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

/** Key sets from `CF_ACCESS_JWKS_JSON`, by its text. Built once, never fetched. */
const inlineJwksByKey = new Map<string, JWTVerifyGetKey>();

/**
 * Fetched key sets (`CF_ACCESS_JWKS_URL` or the team's
 * `/cdn-cgi/access/certs`), by URL, with jose's defaults for `createRemoteJWKSet`:
 * kept {@link REMOTE_JWKS_MAX_AGE_MS}, refetched for an unknown `kid` at most
 * once per {@link REMOTE_JWKS_COOLDOWN_MS}, and a fetch gives up after
 * {@link REMOTE_JWKS_TIMEOUT_MS}.
 *
 * Only a parsed key set is shared between requests, never a fetch in flight.
 * A fetch belongs to the request that started it: when that request ends
 * first, workerd cancels it, and another request awaiting the same promise
 * would hang until the runtime cancelled it, or fail with "Cannot perform I/O
 * on behalf of a different request" (see `server/ip-access.ts`). jose's remote
 * set shares its pending reload and only stops doing so when it detects
 * Cloudflare Workers by its globals; this cache does not depend on that. A
 * request that finds the keys missing or stale fetches them itself.
 */
const REMOTE_JWKS_MAX_AGE_MS = 10 * 60_000;
const REMOTE_JWKS_COOLDOWN_MS = 30_000;
const REMOTE_JWKS_TIMEOUT_MS = 5_000;

type RemoteJwks = Readonly<{
  getKey: JWTVerifyGetKey;
  loadedAt: number;
  /** Order the fetch started in, so an older fetch cannot replace a newer set. */
  sequence: number;
}>;

const remoteJwksByUrl = new Map<string, RemoteJwks>();
/** When a refetch for an unknown `kid` last started, by URL. */
const unknownKidRefetchAt = new Map<string, number>();
let fetchSequence = 0;
/** Sequence at the last {@link forgetAccessJwks}; fetches started before it are not kept. */
let forgottenAtSequence = 0;

/** Drop this isolate's Access key sets (tests). */
export const forgetAccessJwks = (): void => {
  inlineJwksByKey.clear();
  remoteJwksByUrl.clear();
  unknownKidRefetchAt.clear();
  forgottenAtSequence = fetchSequence;
};

const isNoMatchingKey = (cause: unknown): boolean => {
  const parsed = parseJoseErrorCode(cause);
  return parsed.isOk() && parsed.value.code === "ERR_JWKS_NO_MATCHING_KEY";
};

const groupsFromClaims = (claims: z.infer<typeof AccessJwtClaimsSchema>): ReadonlyArray<string> => {
  const customGroups = claims.custom?.groups;
  const fromCustom = Array.isArray(customGroups)
    ? customGroups.filter((value): value is string => typeof value === "string")
    : [];
  return [...(claims.groups ?? []), ...fromCustom];
};

/** The usable keys of a JWKS document, as a jose key lookup. */
const localJwks = (raw: unknown): Result<JWTVerifyGetKey, AccessJwtError> => {
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
    return ok(createLocalJWKSet({ keys }));
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

const inlineJwks = (inline: string): Result<JWTVerifyGetKey, AccessJwtError> => {
  const cacheKey = `json:${inline}`;
  const cached = inlineJwksByKey.get(cacheKey);
  if (cached) {
    return ok(cached);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(inline);
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
  const jwks = localJwks(raw);
  if (jwks.isOk()) {
    inlineJwksByKey.set(cacheKey, jwks.value);
  }
  return jwks;
};

/**
 * Fetch the key set at `url` for this request and keep it for the isolate.
 * A failed, slow (over {@link REMOTE_JWKS_TIMEOUT_MS}), non-200, or unusable
 * answer is `VerificationUnavailable`.
 */
const fetchRemoteJwks = async (
  url: string,
  nowMs: number,
): Promise<Result<RemoteJwks, AccessJwtError>> => {
  fetchSequence += 1;
  const sequence = fetchSequence;
  let raw: unknown;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json, application/jwk-set+json" },
      signal: AbortSignal.timeout(REMOTE_JWKS_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return err({ kind: "VerificationUnavailable" });
    }
    raw = await response.json();
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
  const getKey = localJwks(raw);
  if (getKey.isErr()) {
    return err(getKey.error);
  }
  const loaded: RemoteJwks = { getKey: getKey.value, loadedAt: nowMs, sequence };
  const current = remoteJwksByUrl.get(url);
  if (sequence > (current?.sequence ?? forgottenAtSequence)) {
    remoteJwksByUrl.set(url, loaded);
  }
  return ok(loaded);
};

type AccessKeys =
  | Readonly<{ kind: "Inline"; getKey: JWTVerifyGetKey }>
  | Readonly<{ kind: "Remote"; url: string; jwks: RemoteJwks; fetched: boolean }>;

const accessKeys = async (env: Env, nowMs: number): Promise<Result<AccessKeys, AccessJwtError>> => {
  const inline = optionalEnvString(env, "CF_ACCESS_JWKS_JSON").trim();
  if (inline.length > 0) {
    return inlineJwks(inline).map((getKey) => ({ kind: "Inline", getKey }) as const);
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
  const cached = remoteJwksByUrl.get(url);
  if (cached && nowMs - cached.loadedAt < REMOTE_JWKS_MAX_AGE_MS) {
    return ok({ kind: "Remote", url, jwks: cached, fetched: false });
  }
  const fetched = await fetchRemoteJwks(url, nowMs);
  return fetched.map((jwks) => ({ kind: "Remote", url, jwks, fetched: true }) as const);
};

/**
 * Whether a token whose `kid` is not in `keys` may refetch them: not if this
 * request just fetched them, and at most once per
 * {@link REMOTE_JWKS_COOLDOWN_MS} per URL, counted from the last load and the
 * last such refetch, so made-up `kid`s cannot drive a fetch per request.
 */
const mayRefetchForUnknownKid = (
  keys: Extract<AccessKeys, { kind: "Remote" }>,
  nowMs: number,
): boolean => {
  if (keys.fetched) {
    return false;
  }
  const current = remoteJwksByUrl.get(keys.url);
  const loadedAt = Math.max(keys.jwks.loadedAt, current?.loadedAt ?? Number.NEGATIVE_INFINITY);
  const refetchedAt = unknownKidRefetchAt.get(keys.url) ?? Number.NEGATIVE_INFINITY;
  return (
    nowMs - loadedAt >= REMOTE_JWKS_COOLDOWN_MS && nowMs - refetchedAt >= REMOTE_JWKS_COOLDOWN_MS
  );
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
  nowMs: number = Date.now(),
): Promise<Result<AccessIdentity, AccessJwtError>> => {
  const teamDomain = accessTeamDomain(env);
  const audience = optionalEnvString(env, "CF_ACCESS_AUD").trim();
  if (teamDomain.length === 0 || audience.length === 0) {
    return err({ kind: "NotConfigured" });
  }
  const keys = await accessKeys(env, nowMs);
  if (keys.isErr()) {
    return err(keys.error);
  }
  const verify = (getKey: JWTVerifyGetKey) =>
    jwtVerify(token, getKey, {
      issuer: teamDomain,
      audience,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
  let verified: Awaited<ReturnType<typeof verify>>;
  try {
    verified = await verify(
      keys.value.kind === "Inline" ? keys.value.getKey : keys.value.jwks.getKey,
    );
  } catch (cause) {
    if (
      keys.value.kind !== "Remote" ||
      !isNoMatchingKey(cause) ||
      !mayRefetchForUnknownKid(keys.value, nowMs)
    ) {
      return err({ kind: "InvalidToken" });
    }
    // A `kid` the cached set lacks: Access may have rotated its keys.
    unknownKidRefetchAt.set(keys.value.url, nowMs);
    const refetched = await fetchRemoteJwks(keys.value.url, nowMs);
    if (refetched.isErr()) {
      return err(refetched.error);
    }
    try {
      verified = await verify(refetched.value.getKey);
    } catch {
      return err({ kind: "InvalidToken" });
    }
  }
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
