import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { newEntityId } from "./ids";
import { nowIso } from "./clock";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { queryTyped, runTyped } from "./typed-sql";
import {
  deleteEndorsement as deleteEndorsementSql,
  insertEndorsement as insertEndorsementSql,
} from "./generated/prisma/sql";

const TargetActorUriRow = z.object({ target_actor_uri: z.string() });

export const endorseAccount = async (
  db: D1Database,
  viewerId: string,
  target: Readonly<{ accountId: string | null; actorUri: string }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertEndorsementSql(newEntityId(), viewerId, target.accountId, target.actorUri, nowIso()),
    );
  });

export const unendorseAccount = async (
  db: D1Database,
  viewerId: string,
  targetId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, deleteEndorsementSql(viewerId, targetId), TargetActorUriRow);
    return rows.length > 0;
  });

/** Which endorsements a list reads: one page, or every one of them. */
export type EndorsementPage =
  | Readonly<{ kind: "Page"; limit: number; cursor: IdCursor }>
  | Readonly<{ kind: "All" }>;

/** Endorsed targets, newest first, as local account ids or remote actor URIs. */
export const listEndorsements = async (
  db: D1Database,
  viewerId: string,
  page: EndorsementPage,
): Promise<
  Result<
    ReadonlyArray<Readonly<{ id: string; accountId: string | null; actorUri: string }>>,
    RepositoryError
  >
> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(page.kind === "Page" ? page.cursor : {});
    const statement = db.prepare(
      `SELECT id, target_account_id, target_actor_uri FROM endorsements
       WHERE account_id = ? ${where} ${order}${page.kind === "Page" ? " LIMIT ?" : ""}`,
    );
    const { results } = await (
      page.kind === "Page"
        ? statement.bind(viewerId, ...binds, page.limit)
        : statement.bind(viewerId, ...binds)
    ).all();
    const rows = parseRows(
      z.object({
        id: z.string(),
        target_account_id: z.string().nullable(),
        target_actor_uri: z.string(),
      }),
      results,
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.target_account_id,
      actorUri: row.target_actor_uri,
    }));
  });
