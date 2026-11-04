import { warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { runD1, type RepositoryError } from "./d1";
import {
  listBlockersOfActor as listBlockersOfActorSql,
  listMutersOfActor as listMutersOfActorSql,
  listNotersOfActor as listNotersOfActorSql,
} from "./generated/prisma/sql";
import { queryTyped } from "./typed-sql";

/** One page of local accounts, in account id order; `next` is the cursor of the following page, if any. */
export type AccountPage<T> = Readonly<{ rows: ReadonlyArray<T>; next: string | undefined }>;

const pageOf = <T extends { accountId: string }>(
  rows: ReadonlyArray<T>,
  limit: number,
): AccountPage<T> => ({
  rows,
  next: rows.length >= limit ? rows.at(-1)?.accountId : undefined,
});

const BlockerRowSchema = z.object({ account_id: z.string().min(1) });

/** The local accounts that block `targetActorUri`, after `afterId`. */
export const listBlockers = async (
  db: D1Database,
  targetActorUri: string,
  afterId: string,
  limit: number,
): Promise<Result<AccountPage<{ accountId: string }>, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, listBlockersOfActorSql(targetActorUri, afterId, limit), BlockerRowSchema),
  );
  return rows.isErr()
    ? err(rows.error)
    : ok(
        pageOf(
          rows.value.map((row) => ({ accountId: row.account_id })),
          limit,
        ),
      );
};

const MuterRowSchema = z.object({
  account_id: z.string().min(1),
  notifications: z.number(),
  expires_at: z.string().nullable(),
});

export type MuterRow = Readonly<{
  accountId: string;
  notifications: boolean;
  expiresAt: string | null;
}>;

/** The local accounts that mute `targetActorUri`, after `afterId`, expired mutes included. */
export const listMuters = async (
  db: D1Database,
  targetActorUri: string,
  afterId: string,
  limit: number,
): Promise<Result<AccountPage<MuterRow>, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, listMutersOfActorSql(targetActorUri, afterId, limit), MuterRowSchema),
  );
  return rows.isErr()
    ? err(rows.error)
    : ok(
        pageOf(
          rows.value.map((row) => ({
            accountId: row.account_id,
            notifications: row.notifications !== 0,
            expiresAt: row.expires_at,
          })),
          limit,
        ),
      );
};

const NoterRowSchema = z.object({ account_id: z.string().min(1), note: z.string() });

export type NoterRow = Readonly<{ accountId: string; note: string }>;

/** The local accounts with a note on `targetActorUri`, after `afterId`. */
export const listNoters = async (
  db: D1Database,
  targetActorUri: string,
  afterId: string,
  limit: number,
): Promise<Result<AccountPage<NoterRow>, RepositoryError>> => {
  const rows = await runD1(async () =>
    queryTyped(db, listNotersOfActorSql(targetActorUri, afterId, limit), NoterRowSchema),
  );
  return rows.isErr()
    ? err(rows.error)
    : ok(
        pageOf(
          rows.value.map((row) => ({
            accountId: row.account_id,
            note: row.note,
          })),
          limit,
        ),
      );
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([BlockerRowSchema, MuterRowSchema, NoterRowSchema]);
