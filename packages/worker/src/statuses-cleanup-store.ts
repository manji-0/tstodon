import {
  AccountId,
  type AccountIdValue,
  StatusesCleanupPolicy,
  type StatusesCleanupPolicyValue,
} from "@tstodon/domain";
import type { LocalNote } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { parseRows, runD1, type RepositoryError } from "./d1";
import { hydrateStatusRows, statusSelect } from "./status-store";

const PolicyRowSchema = z.object({
  enabled: z.number(),
  min_status_age: z.number(),
  keep_pinned: z.number(),
  keep_direct: z.number(),
  keep_self_fav: z.number(),
  keep_self_bookmark: z.number(),
  keep_polls: z.number(),
  keep_media: z.number(),
  min_favs: z.number().nullable(),
  min_reblogs: z.number().nullable(),
});

const POLICY_COLUMNS =
  "enabled, min_status_age, keep_pinned, keep_direct, keep_self_fav, keep_self_bookmark, keep_polls, keep_media, min_favs, min_reblogs";

const threshold = (count: number | null) =>
  count === null || count < 1 ? ({ kind: "Off" } as const) : ({ kind: "AtLeast", count } as const);

const policyFromRow = (
  row: z.infer<typeof PolicyRowSchema>,
): StatusesCleanupPolicyValue | undefined => {
  const parsed = StatusesCleanupPolicy.parse({
    kind: row.enabled === 1 ? "Enabled" : "Disabled",
    rules: {
      minAgeSeconds: row.min_status_age,
      keepPinned: row.keep_pinned === 1,
      keepDirect: row.keep_direct === 1,
      keepSelfFavourited: row.keep_self_fav === 1,
      keepSelfBookmarked: row.keep_self_bookmark === 1,
      keepPolls: row.keep_polls === 1,
      keepMedia: row.keep_media === 1,
      keepFavourites: threshold(row.min_favs),
      keepBoosts: threshold(row.min_reblogs),
    },
  });
  return parsed.isOk() ? parsed.value : undefined;
};

const thresholdColumn = (value: StatusesCleanupPolicyValue["rules"]["keepFavourites"]) =>
  value.kind === "AtLeast" ? value.count : null;

/** The account's policy; the default (disabled) one when it never saved the page. */
export const findStatusesCleanupPolicy = async (
  db: D1Database,
  accountId: string,
): Promise<Result<StatusesCleanupPolicyValue, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(`SELECT ${POLICY_COLUMNS} FROM statuses_cleanup_policies WHERE account_id = ?`)
      .bind(accountId)
      .all();
    const row = parseRows(PolicyRowSchema, rows.results)[0];
    return (row && policyFromRow(row)) ?? StatusesCleanupPolicy.default;
  });

/** Save the policy. A changed policy restarts the cleanup from the oldest post. */
export const saveStatusesCleanupPolicy = async (
  db: D1Database,
  accountId: string,
  policy: StatusesCleanupPolicyValue,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    const rules = policy.rules;
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO statuses_cleanup_policies
           (account_id, ${POLICY_COLUMNS}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           enabled = excluded.enabled,
           min_status_age = excluded.min_status_age,
           keep_pinned = excluded.keep_pinned,
           keep_direct = excluded.keep_direct,
           keep_self_fav = excluded.keep_self_fav,
           keep_self_bookmark = excluded.keep_self_bookmark,
           keep_polls = excluded.keep_polls,
           keep_media = excluded.keep_media,
           min_favs = excluded.min_favs,
           min_reblogs = excluded.min_reblogs,
           last_inspected_id = '',
           updated_at = excluded.updated_at`,
      )
      .bind(
        accountId,
        policy.kind === "Enabled" ? 1 : 0,
        rules.minAgeSeconds,
        rules.keepPinned ? 1 : 0,
        rules.keepDirect ? 1 : 0,
        rules.keepSelfFavourited ? 1 : 0,
        rules.keepSelfBookmarked ? 1 : 0,
        rules.keepPolls ? 1 : 0,
        rules.keepMedia ? 1 : 0,
        thresholdColumn(rules.keepFavourites),
        thresholdColumn(rules.keepBoosts),
        now,
        now,
      )
      .run();
  });

/** The accounts whose policy is on. */
export const listEnabledCleanupAccountIds = async (
  db: D1Database,
): Promise<Result<ReadonlyArray<AccountIdValue>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare("SELECT account_id FROM statuses_cleanup_policies WHERE enabled = 1")
      .all();
    return parseRows(z.object({ account_id: AccountId.schema }), rows.results).map(
      (row) => row.account_id,
    );
  });

/** Where the account's next cleanup run starts: after this status id (empty: at the oldest). */
export const findCleanupCursor = async (
  db: D1Database,
  accountId: string,
): Promise<Result<string, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare("SELECT last_inspected_id FROM statuses_cleanup_policies WHERE account_id = ?")
      .bind(accountId)
      .all();
    return (
      parseRows(z.object({ last_inspected_id: z.string() }), rows.results)[0]?.last_inspected_id ??
      ""
    );
  });

export const saveCleanupCursor = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("UPDATE statuses_cleanup_policies SET last_inspected_id = ? WHERE account_id = ?")
      .bind(statusId, accountId)
      .run();
  });

/**
 * The account's own notes published at or before `cutoff`, oldest first,
 * after the status `afterId` (empty for the oldest).
 */
export const listCleanupCandidates = async (
  db: D1Database,
  accountId: string,
  afterId: string,
  cutoff: string,
  limit: number,
): Promise<Result<ReadonlyArray<LocalNote>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE account_id = ? AND kind = 'LocalNote' AND id > ? AND created_at <= ?
         ORDER BY id ASC LIMIT ?`,
      )
      .bind(accountId, afterId, cutoff, limit)
      .all();
    const statuses = await hydrateStatusRows(db, rows.results ?? []);
    return statuses.flatMap((status) => (status.kind === "LocalNote" ? [status] : []));
  });
