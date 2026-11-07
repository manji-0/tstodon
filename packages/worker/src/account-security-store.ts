import { Sensitive, type SensitiveValue } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAuthorizationCodesOfAccount,
  deleteAuthorizedApplicationTokens,
  deleteOwnAuthSession,
  listAuthorizedApplicationTokens,
  listAuthSessions,
} from "./generated/prisma/sql";
import { queryTyped, runTyped, runTypedBatch } from "./typed-sql";

/**
 * What the "Password and security" page can change: the local record of the
 * Access login (a Better Auth session row, keyed by its user id) and the
 * OAuth apps allowed to use the account. Every write names its owner in the
 * `WHERE`, so a guessed id of someone else's row matches nothing.
 */

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
