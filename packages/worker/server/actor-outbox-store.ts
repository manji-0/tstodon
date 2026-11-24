import type { StatusVisibilityParam } from "@tstodon/api/values";
import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { type IdCursor, idCursorFragment } from "./id-cursor";

/** A stored `statuses.visibility`. */
export type StoredVisibility = StatusVisibilityParam;

/**
 * What an outbox page shows its fetcher, as Mastodon's
 * `AccountStatusesFilter`: the statuses of `visibilities`, and those of
 * `mentioned.visibilities` that mention the fetching actor.
 */
export type OutboxReader = Readonly<{
  visibilities: ReadonlyArray<StoredVisibility>;
  mentioned?: Readonly<{ actorUri: string; visibilities: ReadonlyArray<StoredVisibility> }>;
}>;

const IdRow = z.object({ id: z.string() });

/**
 * The ids of a page of the account's statuses and boosts `reader` may read,
 * in the cursor's order. Each visibility is its own range of
 * `idx_statuses_account_visibility_id`, merged in id order, so a page reads
 * its rows and not the statuses of other visibilities between them. The
 * mentions of one actor are few, so their branch starts from them: `CROSS
 * JOIN` keeps that order, as without `sqlite_stat1` (D1 has none) SQLite
 * would walk the account's statuses in id order to skip the merge's sort, all
 * of them for a signer mentioned nowhere.
 */
export const listOutboxStatusIds = async (
  db: D1Database,
  accountId: string,
  reader: OutboxReader,
  cursor: IdCursor,
  limit: number,
): Promise<Result<string[], RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(cursor);
    const branches = reader.visibilities.map((visibility) => ({
      sql: `SELECT id FROM statuses WHERE account_id = ? AND visibility = ? ${where}`,
      binds: [accountId, visibility, ...binds],
    }));
    const mentioned = reader.mentioned;
    if (mentioned !== undefined && mentioned.visibilities.length > 0) {
      const scoped = idCursorFragment(cursor, "s.id");
      branches.push({
        sql: `SELECT s.id AS id FROM status_remote_mentions m CROSS JOIN statuses s ON s.id = m.status_id
              WHERE m.actor_uri = ? AND s.account_id = ?
                AND s.visibility IN (SELECT value FROM json_each(?)) ${scoped.where}`,
        binds: [
          mentioned.actorUri,
          accountId,
          JSON.stringify(mentioned.visibilities),
          ...scoped.binds,
        ],
      });
    }
    if (branches.length === 0) {
      return [];
    }
    const { results } = await db
      .prepare(`${branches.map((branch) => branch.sql).join(" UNION ALL ")} ${order} LIMIT ?`)
      .bind(...branches.flatMap((branch) => branch.binds), limit)
      .all();
    return parseRows(IdRow, results).map((row) => row.id);
  });
