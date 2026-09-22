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
import { runD1, type RepositoryError } from "./d1";
import { parseRow, StatusRowSchema, toRepositoryError } from "./schemas";
import { visibilitySql } from "./sql-enums";

export type StatusRow = z.infer<typeof StatusRowSchema>;

const statusSelect = `id, account_id, kind, reblog_of_id, in_reply_to_id, content_text, COALESCE(content_html, '') AS content_html, visibility, sensitive, COALESCE(spoiler_text, '') AS spoiler_text, language, created_at, poll_id`;

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
): Promise<Result<LocalStatusValue | undefined, RepositoryError>> => {
  const queried = await runD1(() =>
    db.prepare(`SELECT ${statusSelect} FROM statuses WHERE id = ?`).bind(id).first(),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  if (!queried.value) {
    return ok(undefined);
  }
  const row = parseRow(StatusRowSchema, queried.value);
  if (row.isErr()) {
    return err(toRepositoryError("invalid status row"));
  }
  const media = await runD1(() => mediaIdsFor(db, id));
  if (media.isErr()) {
    return err(media.error);
  }
  return statusFromRow(row.value, media.value);
};

export const insertLocalNote = async (
  db: D1Database,
  note: LocalNote,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `INSERT INTO statuses (
          id, account_id, kind, in_reply_to_id, content_text, content_html, visibility, sensitive,
          spoiler_text, language, created_at, updated_at
        ) VALUES (?, ?, 'LocalNote', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
    const stmt = maxId ? db.prepare(sql).bind(maxId, limit) : db.prepare(sql).bind(limit);
    const { results } = await stmt.all();
    return hydrateRows(db, results ?? []);
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
    const { results } = await stmt.all();
    return hydrateRows(db, results ?? []);
  });

export const listAccountStatuses = async (
  db: D1Database,
  accountId: string,
  limit: number,
): Promise<Result<LocalStatusValue[], RepositoryError>> =>
  runD1(async () => {
    const { results } = await db
      .prepare(`SELECT ${statusSelect} FROM statuses WHERE account_id = ? ORDER BY id DESC LIMIT ?`)
      .bind(accountId, limit)
      .all();
    return hydrateRows(db, results ?? []);
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
    return hydrateRows(db, results ?? []);
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

export const countStatuses = async (db: D1Database): Promise<Result<number, RepositoryError>> =>
  runD1(async () => {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM statuses`)
      .first<{ count: number }>();
    return row?.count ?? 0;
  });

const hydrateRows = async (db: D1Database, rows: unknown[]): Promise<LocalStatusValue[]> => {
  const statuses: LocalStatusValue[] = [];
  for (const raw of rows) {
    const row = parseRow(StatusRowSchema, raw);
    if (row.isErr()) {
      continue;
    }
    const mediaIds = await mediaIdsFor(db, row.value.id);
    const parsed = statusFromRow(row.value, mediaIds);
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
      .all();
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
      .all();
    return hydrateRows(db, results ?? []);
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
      const children = await hydrateRows(db, results ?? []);
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
    return hydrateRows(db, results ?? []);
  });

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
