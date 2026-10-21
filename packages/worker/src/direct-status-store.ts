import type { LocalStatus as LocalStatusValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./block-mute-store";
import {
  CONTEXT_ANCESTOR_LIMIT,
  findStatusById,
  hydrateStatusRows,
  statusSelect,
} from "./status-store";

export const listDirectStatusesForAccount = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const suppressed = `AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}`;
    const sql = maxId
      ? `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'direct'
           AND (account_id = ? OR id IN (SELECT status_id FROM status_mentions WHERE account_id = ?))
           ${suppressed}
           AND id < ?
         ORDER BY id DESC LIMIT ?`
      : `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'direct'
           AND (account_id = ? OR id IN (SELECT status_id FROM status_mentions WHERE account_id = ?))
           ${suppressed}
         ORDER BY id DESC LIMIT ?`;
    const now = nowIso();
    const stmt = maxId
      ? db
          .prepare(sql)
          .bind(accountId, accountId, accountId, accountId, accountId, now, maxId, limit)
      : db.prepare(sql).bind(accountId, accountId, accountId, accountId, accountId, now, limit);
    const { results } = await stmt.all();
    return hydrateStatusRows(db, results ?? []);
  });

export const resolveDirectConversationRoot = async (
  db: D1Database,
  status: LocalStatusValue,
): Promise<Result<string, RepositoryError>> => {
  if (status.kind !== "LocalNote" || status.visibility.kind !== "Direct") {
    return ok(status.id);
  }
  let current: LocalStatusValue = status;
  for (let depth = 0; depth < CONTEXT_ANCESTOR_LIMIT; depth += 1) {
    if (current.kind !== "LocalNote" || !current.inReplyToId) {
      break;
    }
    const parent = await findStatusById(db, current.inReplyToId);
    if (parent.isErr()) {
      return err(parent.error);
    }
    if (
      !parent.value ||
      parent.value.kind !== "LocalNote" ||
      parent.value.visibility.kind !== "Direct"
    ) {
      break;
    }
    current = parent.value;
  }
  return ok(current.id);
};
