import { Sensitive, type SensitiveValue } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAuthorizationCodesOfAccount,
  deleteAuthorizedApplicationTokens,
  deleteAuthPasskeyKeepingOne,
  deleteOwnAuthSession,
  listAuthorizedApplicationTokens,
  listAuthPasskeys,
  listAuthSessions,
  renameAuthPasskey,
} from "./generated/prisma/sql";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";

/**
 * The credentials behind an account's sign-in, as the "Password and
 * security" page shows them: passkeys and browser sessions are Better Auth's
 * (keyed by its user id), authorized apps are OAuth access tokens (keyed by
 * the local account id). Every write names its owner in the `WHERE`, so a
 * guessed id of someone else's row matches nothing.
 */

export type PasskeyEntry = Readonly<{
  id: string;
  name: string | undefined;
  addedAt: Date | undefined;
  /** `multiDevice` passkeys sync between a person's devices. */
  deviceType: string;
  backedUp: boolean;
}>;

export type SessionEntry = Readonly<{
  id: string;
  signedInAt: Date;
  expiresAt: Date;
  ipAddress: SensitiveValue<string> | undefined;
  userAgent: string | undefined;
}>;

/** An app the account authorized: its tokens, merged. */
export type AuthorizedApp = Readonly<{
  applicationId: string;
  name: string;
  website: string | undefined;
  scopes: ReadonlyArray<string>;
  authorizedAt: Date;
}>;

const PasskeyRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  createdAt: z.number().nullable(),
  deviceType: z.string(),
  backedUp: z.number(),
});

export const listPasskeys = async (
  db: D1Database,
  userId: string,
): Promise<Result<ReadonlyArray<PasskeyEntry>, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listAuthPasskeys(userId), PasskeyRowSchema)).map((row) => ({
      id: row.id,
      name: row.name?.trim() || undefined,
      addedAt: row.createdAt === null ? undefined : new Date(row.createdAt),
      deviceType: row.deviceType,
      backedUp: row.backedUp !== 0,
    })),
  );

/** Whether a rename changed a passkey of this user. */
export const renamePasskey = async (
  db: D1Database,
  userId: string,
  passkeyId: string,
  name: string,
): Promise<Result<"Renamed" | "NotFound", RepositoryError>> =>
  (await runD1(() => runTyped(db, renameAuthPasskey(passkeyId, userId, name)))).map((result) =>
    result.meta.changes > 0 ? "Renamed" : "NotFound",
  );

export type PasskeyRemoval = "Removed" | "NotFound" | "LastPasskey";

/**
 * Remove one of the user's passkeys, never the last: the delete itself
 * refuses when it would leave none, since sign-in is passkey-only.
 */
export const removePasskey = async (
  db: D1Database,
  userId: string,
  passkeyId: string,
): Promise<Result<PasskeyRemoval, RepositoryError>> => {
  const deleted = await runD1(() => runTyped(db, deleteAuthPasskeyKeepingOne(passkeyId, userId)));
  if (deleted.isErr()) {
    return err(deleted.error);
  }
  if (deleted.value.meta.changes > 0) {
    return ok("Removed");
  }
  const remaining = await listPasskeys(db, userId);
  if (remaining.isErr()) {
    return err(remaining.error);
  }
  return ok(
    remaining.value.some((passkey) => passkey.id === passkeyId) ? "LastPasskey" : "NotFound",
  );
};

const SessionRowSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  ipAddress: z
    .string()
    .nullable()
    .transform((ip) => {
      const trimmed = ip?.trim();
      return trimmed ? Sensitive.of(trimmed) : undefined;
    }),
  userAgent: z.string().nullable(),
});

/** The user's unexpired browser sessions, newest first. */
export const listSessions = async (
  db: D1Database,
  userId: string,
  now: number = Date.now(),
): Promise<Result<ReadonlyArray<SessionEntry>, RepositoryError>> =>
  runD1(async () =>
    (await queryTyped(db, listAuthSessions(userId, now), SessionRowSchema)).map((row) => ({
      id: row.id,
      signedInAt: new Date(row.createdAt),
      expiresAt: new Date(row.expiresAt),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent?.trim() || undefined,
    })),
  );

/**
 * End one of the user's sessions. The web app's token for it goes too (its
 * foreign key cascades), so the browser is signed out of the API as well.
 */
export const revokeSession = async (
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<Result<"Revoked" | "NotFound", RepositoryError>> =>
  (await runD1(() => runTyped(db, deleteOwnAuthSession(sessionId, userId)))).map((result) =>
    result.meta.changes > 0 ? "Revoked" : "NotFound",
  );

const AppTokenRowSchema = z.object({
  application_id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  scopes: z.string(),
  created_at: z.string(),
});

const mergeScopes = (lists: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(lists.flatMap((list) => list.split(" ").filter((scope) => scope.length > 0))),
];

/** The apps holding an access token of this account, newest authorization first. */
export const listAuthorizedApplications = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<AuthorizedApp>, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      listAuthorizedApplicationTokens(accountId),
      AppTokenRowSchema,
    );
    const byApp = Map.groupBy(rows, (row) => row.application_id);
    return [...byApp].map(([applicationId, tokens]) => {
      const earliest = tokens.map((token) => Date.parse(token.created_at)).sort((a, b) => a - b)[0];
      return {
        applicationId,
        name: tokens[0]?.name ?? "",
        website: tokens[0]?.website?.trim() || undefined,
        scopes: mergeScopes(tokens.map((token) => token.scopes)),
        authorizedAt: new Date(earliest ?? 0),
      };
    });
  });

/**
 * Revoke an app's access for this account: all its tokens and any code it
 * has not yet redeemed. Another account's tokens for the same app stay.
 */
export const revokeAuthorizedApplication = async (
  db: D1Database,
  accountId: string,
  applicationId: string,
): Promise<Result<"Revoked" | "NotFound", RepositoryError>> => {
  const deleted = await runTypedBatch(db, [
    deleteAuthorizedApplicationTokens(accountId, applicationId),
    deleteAuthorizationCodesOfAccount(accountId, applicationId),
  ]);
  return deleted.map(([tokens]) => ((tokens?.meta.changes ?? 0) > 0 ? "Revoked" : "NotFound"));
};
