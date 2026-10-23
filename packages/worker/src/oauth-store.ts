import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRow, runD1, type RepositoryError } from "./d1";
import {
  consumeOauthAuthorizationCode as consumeOauthAuthorizationCodeSql,
  deleteExpiredOauthAuthorizationCodes as deleteExpiredOauthAuthorizationCodesSql,
  deleteOauthAccessToken as deleteOauthAccessTokenSql,
  findOauthApplicationByClientId as findOauthApplicationByClientIdSql,
  findOauthApplicationById as findOauthApplicationByIdSql,
  insertOauthAccessToken as insertOauthAccessTokenSql,
  insertOauthApplication as insertOauthApplicationSql,
  insertOauthAuthorizationCode as insertOauthAuthorizationCodeSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";

/** An authorization code lives this long between consent and `/oauth/token`. */
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** An unguessable bearer value: 32 random bytes, base64url. */
export const randomSecret = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** Secrets, codes, and tokens are stored only as this digest. */
export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** RFC 7636 `S256`: base64url(SHA-256(verifier)). */
export const pkceS256 = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

const OauthApplicationRowSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  client_secret_hash: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  redirect_uris: z.string(),
  scopes: z.string(),
  created_at: z.string(),
});

export type OauthApplication = Readonly<{
  id: string;
  clientId: string;
  clientSecretHash: string;
  name: string;
  website: string | null;
  redirectUris: ReadonlyArray<string>;
  scopes: ReadonlyArray<string>;
}>;

const applicationFromRow = (row: z.infer<typeof OauthApplicationRowSchema>): OauthApplication => ({
  id: row.id,
  clientId: row.client_id,
  clientSecretHash: row.client_secret_hash,
  name: row.name,
  website: row.website,
  redirectUris: row.redirect_uris.split("\n").filter((uri) => uri.length > 0),
  scopes: row.scopes.split(" ").filter((scope) => scope.length > 0),
});

const firstApplication = (
  rows: ReadonlyArray<unknown>,
): Result<OauthApplication | undefined, RepositoryError> => {
  const raw = rows[0];
  if (raw === undefined) {
    return ok(undefined);
  }
  return parseRow(OauthApplicationRowSchema, raw).map(applicationFromRow);
};

/** A new app and the one time its client secret is visible. */
export type RegisteredApplication = Readonly<{
  application: OauthApplication;
  clientSecret: string;
}>;

export const registerOauthApplication = async (
  db: D1Database,
  input: Readonly<{
    name: string;
    website: string | null;
    redirectUris: ReadonlyArray<string>;
    scopes: ReadonlyArray<string>;
  }>,
): Promise<Result<RegisteredApplication, RepositoryError>> => {
  const clientSecret = randomSecret();
  const application: OauthApplication = {
    id: newEntityId(),
    clientId: randomSecret(),
    clientSecretHash: await sha256Hex(clientSecret),
    name: input.name,
    website: input.website,
    redirectUris: input.redirectUris,
    scopes: input.scopes,
  };
  const inserted = await runD1(() =>
    runTyped(
      db,
      insertOauthApplicationSql(
        application.id,
        application.clientId,
        application.clientSecretHash,
        application.name,
        application.website ?? "",
        application.redirectUris.join("\n"),
        application.scopes.join(" "),
        nowIso(),
      ),
    ),
  );
  return inserted.map(() => ({ application, clientSecret }));
};

export const findOauthApplicationByClientId = async (
  db: D1Database,
  clientId: string,
): Promise<Result<OauthApplication | undefined, RepositoryError>> =>
  (await runD1(() => queryTyped(db, findOauthApplicationByClientIdSql(clientId)))).andThen(
    firstApplication,
  );

export const findOauthApplicationById = async (
  db: D1Database,
  id: string,
): Promise<Result<OauthApplication | undefined, RepositoryError>> =>
  (await runD1(() => queryTyped(db, findOauthApplicationByIdSql(id)))).andThen(firstApplication);

/** The app named by `client_id`, when `clientSecret` is its secret. */
export const authenticateOauthClient = async (
  db: D1Database,
  clientId: string,
  clientSecret: string,
): Promise<Result<OauthApplication | undefined, RepositoryError>> => {
  const application = await findOauthApplicationByClientId(db, clientId);
  if (application.isErr() || !application.value) {
    return application;
  }
  return ok(
    application.value.clientSecretHash === (await sha256Hex(clientSecret))
      ? application.value
      : undefined,
  );
};

export type PkceChallenge = Readonly<{ challenge: string; method: "S256" | "plain" }>;

export const issueAuthorizationCode = async (
  db: D1Database,
  input: Readonly<{
    applicationId: string;
    accountId: string;
    redirectUri: string;
    scopes: ReadonlyArray<string>;
    pkce: PkceChallenge | undefined;
  }>,
): Promise<Result<string, RepositoryError>> => {
  const code = randomSecret();
  const now = new Date();
  const written = await runTypedBatch(db, [
    // Unused codes of this app expire here rather than in a sweep.
    deleteExpiredOauthAuthorizationCodesSql(input.applicationId, now.toISOString()),
    insertOauthAuthorizationCodeSql(
      await sha256Hex(code),
      input.applicationId,
      input.accountId,
      input.redirectUri,
      input.scopes.join(" "),
      input.pkce?.challenge ?? "",
      input.pkce?.method ?? "",
      new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      now.toISOString(),
    ),
  ]);
  return written.map(() => code);
};

const AuthorizationCodeRowSchema = z.object({
  application_id: z.string(),
  account_id: z.string(),
  redirect_uri: z.string(),
  scopes: z.string(),
  code_challenge: z.string().nullable(),
  code_challenge_method: z.union([z.literal("S256"), z.literal("plain")]).nullable(),
  expires_at: z.string(),
});

export type AuthorizationGrant = Readonly<{
  applicationId: string;
  accountId: string;
  redirectUri: string;
  scopes: ReadonlyArray<string>;
  pkce: PkceChallenge | undefined;
}>;

/**
 * Redeem `code` once: the row is deleted whether or not the caller then
 * accepts it, so a replayed code never works. Expired codes read as absent.
 */
export const consumeAuthorizationCode = async (
  db: D1Database,
  code: string,
): Promise<Result<AuthorizationGrant | undefined, RepositoryError>> => {
  const hash = await sha256Hex(code);
  const rows = await runD1(() => queryTyped(db, consumeOauthAuthorizationCodeSql(hash)));
  if (rows.isErr()) {
    return err(rows.error);
  }
  const raw = rows.value[0];
  if (raw === undefined) {
    return ok(undefined);
  }
  const row = parseRow(AuthorizationCodeRowSchema, raw);
  if (row.isErr()) {
    return err(row.error);
  }
  if (Date.parse(row.value.expires_at) <= Date.now()) {
    return ok(undefined);
  }
  return ok({
    applicationId: row.value.application_id,
    accountId: row.value.account_id,
    redirectUri: row.value.redirect_uri,
    scopes: row.value.scopes.split(" ").filter((scope) => scope.length > 0),
    pkce:
      row.value.code_challenge && row.value.code_challenge_method
        ? { challenge: row.value.code_challenge, method: row.value.code_challenge_method }
        : undefined,
  });
};

export type IssuedAccessToken = Readonly<{ token: string; createdAt: string }>;

/** A bearer token for `accountId`, or an app-only token when it is undefined. */
export const issueAccessToken = async (
  db: D1Database,
  input: Readonly<{
    applicationId: string;
    accountId: string | undefined;
    scopes: ReadonlyArray<string>;
  }>,
): Promise<Result<IssuedAccessToken, RepositoryError>> => {
  const token = randomSecret();
  const createdAt = nowIso();
  const inserted = await runD1(async () =>
    runTyped(
      db,
      insertOauthAccessTokenSql(
        newEntityId(),
        await sha256Hex(token),
        input.applicationId,
        input.accountId ?? "",
        input.scopes.join(" "),
        createdAt,
      ),
    ),
  );
  return inserted.map(() => ({ token, createdAt }));
};

/** RFC 7009: revoking an unknown token, or another app's, is not an error. */
export const revokeAccessToken = async (
  db: D1Database,
  applicationId: string,
  token: string,
): Promise<Result<void, RepositoryError>> => {
  const hash = await sha256Hex(token);
  const deleted = await runD1(() => runTyped(db, deleteOauthAccessTokenSql(hash, applicationId)));
  return deleted.map(() => undefined);
};
