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
import { runD1, type RepositoryError } from "./d1";
import { visibilitySql } from "./sql-enums";

export type StatusRow = {
  id: string;
  account_id: string;
  kind: string;
  reblog_of_id: string | null;
  content_text: string;
  content_html: string;
  visibility: string;
  sensitive: number;
  spoiler_text: string;
  language: string | null;
  created_at: string;
  poll_id: string | null;
};

const statusSelect = `id, account_id, kind, reblog_of_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, poll_id`;

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
    createdAt: createdAt.value,
  });
};

const mediaIdsFor = async (db: D1Database, statusId: string): Promise<MediaId[]> => {
  const { results } = await db
    .prepare(`SELECT id FROM media_attachments WHERE status_id = ? ORDER BY created_at`)
    .bind(statusId)
    .all<{ id: string }>();
  return (results ?? []).flatMap((row) => {
    const parsed = MediaId.parse(row.id);
    return parsed.isOk() ? [parsed.value] : [];
  });
};

export const findStatusById = async (
  db: D1Database,
  id: string,
): Promise<Result<LocalStatusValue | undefined, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT ${statusSelect} FROM statuses WHERE id = ?`)
      .bind(id)
      .first<StatusRow>();
    if (!row) {
      return undefined;
    }
    const mediaIds = await mediaIdsFor(db, id);
    const parsed = statusFromRow(row, mediaIds);
    if (parsed.isErr()) {
      throw new Error(parsed.error.message);
    }
    return parsed.value;
  });

export const insertLocalNote = async (
  db: D1Database,
  note: LocalNote,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO statuses (
          id, account_id, kind, content_text, content_html, visibility, sensitive,
          spoiler_text, language, created_at, updated_at
        ) VALUES (?, ?, 'LocalNote', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        note.id,
        note.accountId,
        note.text,
        note.contentHtml,
        visibilitySql(note.visibility),
        note.sensitive ? 1 : 0,
        note.spoilerText,
        note.language.kind === "Present" ? note.language.value : null,
        note.createdAt,
        note.createdAt,
      )
      .run();
    for (const mediaId of note.mediaIds) {
      await db
        .prepare(`UPDATE media_attachments SET status_id = ? WHERE id = ? AND account_id = ?`)
        .bind(note.id, mediaId, note.accountId)
        .run();
    }
  });

export const insertLocalReblog = async (
  db: D1Database,
  reblog: LocalReblog,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO statuses (
          id, account_id, kind, reblog_of_id, content_text, visibility, created_at, updated_at
        ) VALUES (?, ?, 'LocalReblog', ?, '', 'public', ?, ?)`,
      )
      .bind(reblog.id, reblog.accountId, reblog.reblogOfId, reblog.createdAt, reblog.createdAt)
      .run();
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
    const stmt = maxId
      ? db.prepare(sql).bind(maxId, limit)
      : db.prepare(sql).bind(limit);
    const { results } = await stmt.all<StatusRow>();
    const statuses: LocalStatusValue[] = [];
    for (const row of results ?? []) {
      const mediaIds = await mediaIdsFor(db, row.id);
      const parsed = statusFromRow(row, mediaIds);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

export const listHomeStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
  maxId: string | undefined,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const sql = maxId
      ? `SELECT ${statusSelect} FROM statuses
         WHERE (account_id = ? OR account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         )) AND id < ? ORDER BY id DESC LIMIT ?`
      : `SELECT ${statusSelect} FROM statuses
         WHERE account_id = ? OR account_id IN (
           SELECT target_account_id FROM follows WHERE follower_account_id = ? AND kind = 'Accepted'
         ) ORDER BY id DESC LIMIT ?`;
    const stmt = maxId
      ? db.prepare(sql).bind(accountId, accountId, maxId, limit)
      : db.prepare(sql).bind(accountId, accountId, limit);
    const { results } = await stmt.all<StatusRow>();
    const statuses: LocalStatusValue[] = [];
    for (const row of results ?? []) {
      const mediaIds = await mediaIdsFor(db, row.id);
      const parsed = statusFromRow(row, mediaIds);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

export const listAccountStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT ${statusSelect} FROM statuses WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(accountId, limit)
      .all<StatusRow>();
    const statuses: LocalStatusValue[] = [];
    for (const row of results ?? []) {
      const mediaIds = await mediaIdsFor(db, row.id);
      const parsed = statusFromRow(row, mediaIds);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
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
      .all<StatusRow>();
    const statuses: LocalStatusValue[] = [];
    for (const row of results ?? []) {
      const parsed = statusFromRow(row, []);
      if (parsed.isOk()) {
        statuses.push(parsed.value);
      }
    }
    return statuses;
  });

export const deleteStatus = async (
  db: D1Database,
  id: string,
  accountId: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const result = await db
      .prepare(`DELETE FROM statuses WHERE id = ? AND account_id = ?`)
      .bind(id, accountId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  });

export const deleteReblogOf = async (
  db: D1Database,
  accountId: string,
  reblogOfId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `DELETE FROM statuses WHERE account_id = ? AND kind = 'LocalReblog' AND reblog_of_id = ?`,
      )
      .bind(accountId, reblogOfId)
      .run();
  });

export const countStatuses = async (
  db: D1Database,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM statuses`)
      .first<{ count: number }>();
    return row?.count ?? 0;
  });

const hydrateRows = async (
  db: D1Database,
  rows: StatusRow[],
): Promise<LocalStatusValue[]> => {
  const statuses: LocalStatusValue[] = [];
  for (const row of rows) {
    const mediaIds = await mediaIdsFor(db, row.id);
    const parsed = statusFromRow(row, mediaIds);
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
      .all<StatusRow>();
    return hydrateRows(db, results ?? []);
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
      .all<StatusRow>();
    return hydrateRows(db, results ?? []);
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
      .all<StatusRow>();
    return hydrateRows(db, results ?? []);
  });
