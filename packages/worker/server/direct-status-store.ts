import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, type RepositoryError, runD1 } from "./d1";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import { resolveDirectConversationRoots as resolveDirectConversationRootsSql } from "./generated/prisma/sql";
import { CONTEXT_ANCESTOR_LIMIT, hydrateStatusRows, statusSelect } from "./status-store";
import { queryTyped } from "./typed-sql";

export const listDirectStatusesForAccount = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const now = nowIso();
    const suppressedBinds = [accountId, accountId, accountId, now];
    const ownBefore = maxId ? "AND id < ?" : "";
    const mentionBefore = maxId ? "AND m.status_id < ?" : "";
    const beforeBinds = maxId ? [maxId] : [];
    // The page's ids merge the account's own direct notes and the notes that
    // mention it, each read in id order, so a page stops after `limit` ids
    // instead of walking every direct note on the instance.
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE id IN (
           SELECT id FROM statuses
           WHERE kind = 'LocalNote' AND visibility = 'direct' AND account_id = ?
             AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
             ${ownBefore}
           UNION
           SELECT m.status_id FROM status_mentions m CROSS JOIN statuses s ON s.id = m.status_id
           WHERE m.account_id = ? AND s.kind = 'LocalNote' AND s.visibility = 'direct'
             AND s.account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}
             ${mentionBefore}
           ORDER BY 1 DESC LIMIT ?
         )
         ORDER BY id DESC`,
      )
      .bind(
        accountId,
        ...suppressedBinds,
        ...beforeBinds,
        accountId,
        ...suppressedBinds,
        ...beforeBinds,
        limit,
      )
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

/** Where a local status's run of direct replies starts. */
export type DirectConversationRoot = Readonly<{
  /** Whether the status itself is a direct note; a status that is not is its own root. */
  direct: boolean;
  rootId: string;
  /** The remote status the root answers, by object URI. */
  rootInReplyToUri: string | undefined;
}>;

const DirectConversationRootRow = z.object({
  start_id: z.string(),
  start_direct: z.number(),
  root_id: z.string(),
  root_in_reply_to_uri: z.string().nullable(),
});

/**
 * For each stored status in `statusIds`, the first direct note up its local
 * `in_reply_to_id` chain, at most `CONTEXT_ANCESTOR_LIMIT` steps up, in one
 * query. Ids with no stored status are left out.
 */
export const resolveDirectConversationRoots = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, DirectConversationRoot>, RepositoryError>> => {
  if (statusIds.length === 0) {
    return ok(new Map());
  }
  const rows = await runD1(async () =>
    queryTyped(
      db,
      resolveDirectConversationRootsSql(
        jsonStringArray([...new Set(statusIds)]),
        CONTEXT_ANCESTOR_LIMIT,
      ),
      DirectConversationRootRow,
    ),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  return ok(
    new Map(
      rows.value.map((row) => [
        row.start_id,
        {
          direct: row.start_direct === 1,
          rootId: row.root_id,
          rootInReplyToUri: row.root_in_reply_to_uri ?? undefined,
        },
      ]),
    ),
  );
};
