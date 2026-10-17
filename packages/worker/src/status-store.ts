import {
  AccountId,
  IsoInstant,
  MediaId,
  StatusId,
  StatusQuoteTarget,
  Visibility,
  type LocalNote,
  type LocalReblog,
  type LocalStatus as LocalStatusValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, runD1Batch, sqlInJsonEach, type RepositoryError } from "./d1";
import { newEntityId } from "./ids";
import { parseRow, StatusRowSchema, toRepositoryError } from "./schemas";
import { SUPPRESSED_ACCOUNT_IDS_SQL } from "./social-store";
import { visibilitySql } from "./sql-enums";
import { d1PrepareTyped, queryTyped, runTyped } from "./typed-sql";
import {
  attachMediaToStatus as attachMediaToStatusSql,
  countPinnedStatuses as countPinnedStatusesSql,
  countStatuses as countStatusesSql,
  deleteReblogOf as deleteReblogOfSql,
  deleteStatusOwned as deleteStatusOwnedSql,
  detachStatusMedia as detachStatusMediaSql,
  findStatusById as findStatusByIdSql,
  findStatusUpdatedAt as findStatusUpdatedAtSql,
  insertLocalNote as insertLocalNoteSql,
  insertLocalReblog as insertLocalReblogSql,
  insertStatusEdit as insertStatusEditSql,
  isStatusPinned as isStatusPinnedSql,
  listAccountStatuses as listAccountStatusesSql,
  listAccountStatusesFiltered as listAccountStatusesFilteredSql,
  listMediaIdsForStatus as listMediaIdsForStatusSql,
  listPinnedStatuses as listPinnedStatusesSql,
  listStatusEditSnapshots as listStatusEditSnapshotsSql,
  pinStatus as pinStatusSql,
  unpinStatus as unpinStatusSql,
  updateLocalNote as updateLocalNoteSql,
} from "./generated/prisma/sql";

export type StatusRow = z.infer<typeof StatusRowSchema>;

export const STATUS_SELECT = `id, account_id, kind, reblog_of_id, in_reply_to_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, updated_at, poll_id`;
const statusSelect = STATUS_SELECT;

const CONTEXT_ANCESTOR_LIMIT = 40;
const CONTEXT_DESCENDANT_LIMIT = 60;

export const statusFromRow = (
  row: StatusRow,
  mediaIds: ReadonlyArray<MediaId> = [],
): Result<LocalStatusValue, RepositoryError> => {
  const id = StatusId.parse(row.id);
  const accountId = AccountId.parse(row.account_id);
  const createdAt = IsoInstant.parse(row.created_at);
  if (id.isErr() || accountId.isErr() || createdAt.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid status ids" });
  }
  if (row.kind === "LocalReblog") {
    if (!row.reblog_of_id) {
      return err({ kind: "RepositoryError", message: "reblog missing target" });
    }
    const reblogOfId = StatusId.parse(row.reblog_of_id);
    if (reblogOfId.isErr()) {
      return err({ kind: "RepositoryError", message: "invalid reblog target" });
    }
    return ok({
      kind: "LocalReblog",
      id: id.value,
      accountId: accountId.value,
      reblogOfId: reblogOfId.value,
      createdAt: createdAt.value,
    });
  }
  const visibility = Visibility.fromMastodon(row.visibility);
  if (visibility.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid visibility" });
  }
  const language =
    row.language && row.language.length > 0
      ? { kind: "Present" as const, value: row.language }
      : { kind: "None" as const };
  let inReplyToId: StatusId | null = null;
  if (row.in_reply_to_id) {
    const replyTo = StatusId.parse(row.in_reply_to_id);
    if (replyTo.isErr()) {
      return err({ kind: "RepositoryError", message: "invalid in_reply_to_id" });
    }
    inReplyToId = replyTo.value;
  }
  const editedAtValue =
    row.updated_at !== row.created_at ? IsoInstant.parse(row.updated_at) : undefined;
  return ok({
    kind: "LocalNote",
    id: id.value,
    accountId: accountId.value,
    text: row.content_text,
    contentHtml: row.content_html,
    visibility: visibility.value,
    spoilerText: row.spoiler_text,
    sensitive: row.sensitive === 1,
    language,
    quote: StatusQuoteTarget.none,
    mediaIds: [...mediaIds],
    poll: row.poll_id ? { kind: "Present" } : { kind: "None" },
    inReplyToId,
    createdAt: createdAt.value,
    editedAt: editedAtValue?.isOk() ? editedAtValue.value : null,
  });
};

const mediaIdsFor = async (db: D1Database, statusId: string): Promise<MediaId[]> => {
  const results = await queryTyped<{ id: string | null }>(db, listMediaIdsForStatusSql(statusId));
  return results.flatMap((row) => {
    if (!row.id) {
      return [];
    }
    const parsed = MediaId.parse(row.id);
    return parsed.isOk() ? [parsed.value] : [];
  });
};

export const findStatusById = async (
  db: D1Database,
  id: string,
): Promise<Result<LocalStatusValue | undefined, RepositoryError>> => {
  const queried = await runD1(async () => queryTyped(db, findStatusByIdSql(id)));
  if (queried.isErr()) {
    return err(queried.error);
  }
  const raw = queried.value[0];
  if (!raw) {
    return ok(undefined);
  }
  const row = parseRow(StatusRowSchema, raw);
  if (row.isErr()) {
    return err(toRepositoryError("invalid status row"));
  }
  const media = await runD1(() => mediaIdsFor(db, id));
  if (media.isErr()) {
    return err(media.error);
  }
  return statusFromRow(row.value, media.value);
};

export const findStatusesByIds = async (
  db: D1Database,
  ids: ReadonlyArray<string>,
): Promise<Result<Map<string, LocalStatusValue>, RepositoryError>> => {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  const statuses = new Map<string, LocalStatusValue>();
  if (unique.length === 0) {
    return ok(statuses);
  }
  const queried = await runD1(() =>
    db
      .prepare(`SELECT ${statusSelect} FROM statuses WHERE id ${sqlInJsonEach()}`)
      .bind(jsonStringArray(unique))
      .all(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const hydrated = await hydrateStatusRows(db, queried.value.results ?? []);
  for (const status of hydrated) {
    statuses.set(status.id, status);
  }
  return ok(statuses);
};

export const insertLocalNote = async (
  db: D1Database,
  note: LocalNote,
): Promise<Result<void, RepositoryError>> => {
  const statements: D1PreparedStatement[] = [
    d1PrepareTyped(
      db,
      insertLocalNoteSql(
        note.id,
        note.accountId,
        note.inReplyToId,
        note.text,
        note.contentHtml,
        visibilitySql(note.visibility),
        note.sensitive ? 1 : 0,
        note.spoilerText,
        note.language.kind === "Present" ? note.language.value : null,
        note.createdAt,
        note.createdAt,
      ),
    ),
    ...note.mediaIds.map((mediaId) =>
      d1PrepareTyped(db, attachMediaToStatusSql(note.id, mediaId, note.accountId)),
    ),
  ];
  const batched = await runD1Batch(db, statements);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

export const insertLocalReblog = async (
  db: D1Database,
  reblog: LocalReblog,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertLocalReblogSql(
        reblog.id,
        reblog.accountId,
        reblog.reblogOfId,
        reblog.createdAt,
        reblog.createdAt,
      ),
    );
  });

/** Replace a note's media: detach the current attachments, then attach the new set. */
export const replaceStatusMedia = async (
  db: D1Database,
  statusId: string,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  const batched = await runD1Batch(db, [
    d1PrepareTyped(db, detachStatusMediaSql(statusId, accountId)),
    ...mediaIds.map((mediaId) =>
      d1PrepareTyped(db, attachMediaToStatusSql(statusId, mediaId, accountId)),
    ),
  ]);
  if (batched.isErr()) {
    return err(batched.error);
  }
  return ok(undefined);
};

/** Apply an edited note to its status row. False when the row is not the author's. */
export const updateLocalNote = async (
  db: D1Database,
  note: LocalNote,
  updatedAt: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateLocalNoteSql(
        note.id,
        note.text,
        note.contentHtml,
        visibilitySql(note.visibility),
        note.sensitive ? 1 : 0,
        note.spoilerText,
        note.language.kind === "Present" ? note.language.value : null,
        updatedAt,
        note.accountId,
      ),
    );
    return rows.length > 0;
  });

/** Store the previous revision of a status as a history snapshot. */
export const insertStatusEdit = async (
  db: D1Database,
  statusId: string,
  snapshotJson: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, insertStatusEditSql(newEntityId(), statusId, snapshotJson, nowIso()));
  });

/** Previous revisions, newest first. */
export const listStatusEdits = async (
  db: D1Database,
  statusId: string,
): Promise<Result<Record<string, unknown>[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ snapshot_json: string }>(
      db,
      listStatusEditSnapshotsSql(statusId),
    );
    const snapshots: Record<string, unknown>[] = [];
    for (const row of rows) {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      if (parsed !== null && typeof parsed === "object") {
        snapshots.push({ ...parsed });
      }
    }
    return snapshots;
  });

export const findStatusUpdatedAt = async (
  db: D1Database,
  statusId: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ updated_at: string }>(db, findStatusUpdatedAtSql(statusId));
    return rows[0]?.updated_at;
  });

export const pinStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, pinStatusSql(accountId, statusId, nowIso()));
  });

export const unpinStatus = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ status_id: string }>(db, unpinStatusSql(accountId, statusId));
    return rows.length > 0;
  });

export const isStatusPinned = async (
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ present: number }>(db, isStatusPinnedSql(accountId, statusId));
    return rows.length > 0;
  });

export const countPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(
      db,
      countPinnedStatusesSql(accountId),
    );
    return Number(rows[0]?.count ?? 0);
  });

export const listPinnedStatuses = async (
  db: D1Database,
  accountId: string,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listPinnedStatusesSql(accountId));
    return hydrateStatusRows(db, results);
  });

export const listPublicStatuses = async (
  db: D1Database,
  limit: number,
  maxId: string | undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const sql = maxId
      ? `SELECT ${statusSelect} FROM statuses WHERE visibility = 'public' AND id < ? ORDER BY id DESC LIMIT ?`
      : `SELECT ${statusSelect} FROM statuses WHERE visibility = 'public' ORDER BY id DESC LIMIT ?`;
    const stmt = maxId ? db.prepare(sql).bind(maxId, limit) : db.prepare(sql).bind(limit);
    const { results } = await stmt.all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listHomeStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const suppressed = `AND account_id NOT IN ${SUPPRESSED_ACCOUNT_IDS_SQL}`;
    const sql = maxId
      ? `SELECT ${statusSelect} FROM statuses
         WHERE visibility != 'direct' AND (account_id = ? OR account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         )) ${suppressed} AND id < ? ORDER BY id DESC LIMIT ?`
      : `SELECT ${statusSelect} FROM statuses
         WHERE visibility != 'direct' AND (account_id = ? OR account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         )) ${suppressed} ORDER BY id DESC LIMIT ?`;
    const now = nowIso();
    const stmt = maxId
      ? db
          .prepare(sql)
          .bind(accountId, accountId, accountId, accountId, accountId, now, maxId, limit)
      : db.prepare(sql).bind(accountId, accountId, accountId, accountId, accountId, now, limit);
    const { results } = await stmt.all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listAccountStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const results = await queryTyped(db, listAccountStatusesSql(accountId, limit));
    return hydrateStatusRows(db, results);
  });

export type AccountStatusFilters = Readonly<{
  limit: number;
  maxId?: string | undefined;
  excludeReplies: boolean;
  excludeReblogs: boolean;
  onlyMedia: boolean;
  tagged?: string | undefined;
}>;

export const listAccountStatusesFiltered = async (
  db: D1Database,
  accountId: string,
  filters: AccountStatusFilters,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const tagged = filters.tagged?.replace(/^#/, "") ?? "";
    const results = await queryTyped(
      db,
      listAccountStatusesFilteredSql(
        accountId,
        filters.excludeReplies ? 1 : 0,
        filters.excludeReblogs ? 1 : 0,
        filters.onlyMedia ? 1 : 0,
        tagged.length > 0 ? `%#${tagged}%` : "",
        filters.maxId ?? "",
        filters.limit,
      ),
    );
    return hydrateStatusRows(db, results);
  });

export const searchStatuses = async (
  db: D1Database,
  query: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE kind = 'LocalNote' AND content_text LIKE ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(`%${query}%`, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const deleteStatus = async (
  db: D1Database,
  id: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string | null }>(db, deleteStatusOwnedSql(id, accountId));
    return rows.length > 0;
  });

export const deleteReblogOf = async (
  db: D1Database,
  accountId: string,
  reblogOfId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(db, deleteReblogOfSql(accountId, reblogOfId));
  });

export const countStatuses = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ count: number | bigint }>(db, countStatusesSql());
    return Number(rows[0]?.count ?? 0);
  });

export const hydrateStatusRows = async (
  db: D1Database,
  rows: unknown[],
): Promise<LocalStatusValue[]> => {
  const statusRows: StatusRow[] = [];
  for (const raw of rows) {
    const row = parseRow(StatusRowSchema, raw);
    if (row.isOk()) {
      statusRows.push(row.value);
    }
  }
  if (statusRows.length === 0) {
    return [];
  }
  const mediaByStatus = new Map<string, MediaId[]>();
  const { results } = await db
    .prepare(`SELECT status_id, id FROM media_attachments WHERE status_id ${sqlInJsonEach()}`)
    .bind(jsonStringArray(statusRows.map((row) => row.id)))
    .all<{ status_id: string; id: string }>();
  for (const media of results ?? []) {
    const parsed = MediaId.parse(media.id);
    if (parsed.isErr()) {
      continue;
    }
    const list = mediaByStatus.get(media.status_id) ?? [];
    list.push(parsed.value);
    mediaByStatus.set(media.status_id, list);
  }
  const statuses: LocalStatusValue[] = [];
  for (const row of statusRows) {
    const parsed = statusFromRow(row, mediaByStatus.get(row.id) ?? []);
    if (parsed.isOk()) {
      statuses.push(parsed.value);
    }
  }
  return statuses;
};

export const listFavouritedStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE id IN (SELECT status_id FROM favourites WHERE account_id = ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listBookmarkedStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE id IN (SELECT status_id FROM bookmarks WHERE account_id = ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listTagStatuses = async (
  db: D1Database,
  tag: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public'
           AND (content_text LIKE ? OR content_text LIKE ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .bind(`%#${tag}%`, `%#${tag.toLowerCase()}%`, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

export const listStatusAncestors = async (
  db: D1Database,
  statusId: string,
): Promise<Result<LocalStatusValue[], RepositoryError>> => {
  const chain: LocalStatusValue[] = [];
  let currentId: string | undefined = statusId;
  for (let depth = 0; depth < CONTEXT_ANCESTOR_LIMIT; depth += 1) {
    const current = await findStatusById(db, currentId);
    if (current.isErr()) {
      return err(current.error);
    }
    if (!current.value || current.value.kind !== "LocalNote" || !current.value.inReplyToId) {
      break;
    }
    const parent = await findStatusById(db, current.value.inReplyToId);
    if (parent.isErr()) {
      return err(parent.error);
    }
    if (!parent.value) {
      break;
    }
    chain.push(parent.value);
    currentId = parent.value.id;
  }
  return ok(chain.reverse());
};

export const listStatusDescendants = async (
  db: D1Database,
  statusId: string,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const collected: LocalStatusValue[] = [];
    const queue = [statusId];
    const seen = new Set<string>([statusId]);
    while (queue.length > 0 && collected.length < CONTEXT_DESCENDANT_LIMIT) {
      const parentId = queue.shift();
      if (!parentId) {
        break;
      }
      const { results } = await db
        .prepare(
          `SELECT ${statusSelect} FROM statuses
           WHERE in_reply_to_id = ? AND kind = 'LocalNote'
           ORDER BY id ASC LIMIT ?`,
        )
        .bind(parentId, CONTEXT_DESCENDANT_LIMIT - collected.length)
        .all();
      const children = await hydrateStatusRows(db, results ?? []);
      for (const child of children) {
        if (seen.has(child.id)) {
          continue;
        }
        seen.add(child.id);
        collected.push(child);
        queue.push(child.id);
        if (collected.length >= CONTEXT_DESCENDANT_LIMIT) {
          break;
        }
      }
    }
    return collected;
  });

export const extractHashtags = (text: string): string[] => {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([A-Za-z0-9_]+)/g)) {
    const tag = match[1];
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return [...tags];
};

export const listTrendingTags = async (
  db: D1Database,
  limit: number,
): Promise<Result<ReadonlyArray<{ name: string; uses: number }>, RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT content_text FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' AND created_at >= ?
         ORDER BY id DESC LIMIT 500`,
      )
      .bind(since)
      .all<{ content_text: string }>();
    const counts = new Map<string, number>();
    for (const row of results ?? []) {
      for (const tag of extractHashtags(row.content_text)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, uses]) => ({ name, uses }))
      .toSorted((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
      .slice(0, limit);
  });

export const listTrendingStatuses = async (
  db: D1Database,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect},
            (SELECT COUNT(*) FROM favourites f WHERE f.status_id = statuses.id) AS favourite_count,
            (SELECT COUNT(*) FROM statuses r WHERE r.reblog_of_id = statuses.id) AS reblog_count
         FROM statuses
         WHERE kind = 'LocalNote' AND visibility = 'public' AND created_at >= ?
         ORDER BY (favourite_count + reblog_count) DESC, id DESC
         LIMIT ?`,
      )
      .bind(since, limit)
      .all();
    return hydrateStatusRows(db, results ?? []);
  });

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

export const listWeeklyStatusActivity = async (
  db: D1Database,
  weeks: number,
): Promise<
  Result<ReadonlyArray<{ week: string; statuses: number; registrations: number }>, RepositoryError>
> =>
  runD1(async () => {
    const { results: statusRows } = await db
      .prepare(
        `SELECT strftime('%Y-%W', created_at) AS week, COUNT(*) AS statuses
         FROM statuses
         WHERE created_at >= datetime('now', ?)
         GROUP BY week
         ORDER BY week DESC
         LIMIT ?`,
      )
      .bind(`-${weeks * 7} days`, weeks)
      .all<{ week: string; statuses: number }>();
    const { results: registrationRows } = await db
      .prepare(
        `SELECT strftime('%Y-%W', created_at) AS week, COUNT(*) AS registrations
         FROM accounts
         WHERE created_at >= datetime('now', ?)
         GROUP BY week`,
      )
      .bind(`-${weeks * 7} days`)
      .all<{ week: string; registrations: number }>();
    const registrations = new Map(
      (registrationRows ?? []).map((row) => [row.week, Number(row.registrations)]),
    );
    return (statusRows ?? []).map((row) => ({
      week: row.week,
      statuses: Number(row.statuses),
      registrations: registrations.get(row.week) ?? 0,
    }));
  });
