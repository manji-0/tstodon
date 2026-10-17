import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  deleteAnnouncementById as deleteAnnouncementByIdSql,
  findAnnouncementById as findAnnouncementByIdSql,
  insertAnnouncement as insertAnnouncementSql,
  listAdminAnnouncements as listAdminAnnouncementsSql,
  listPublishedAnnouncements as listPublishedAnnouncementsSql,
  setAnnouncementPublished as setAnnouncementPublishedSql,
  updateAnnouncement as updateAnnouncementSql,
} from "./generated/prisma/sql";
import { newEntityId } from "./ids";
import type { Announcement } from "./runtime-config";
import { parseRow } from "./schemas";
import { queryTyped, runTyped } from "./typed-sql";

export const AnnouncementRowSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  all_day: z.number(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type AnnouncementRow = z.infer<typeof AnnouncementRowSchema>;

export type AnnouncementInput = Readonly<{
  content: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  publishedAt: string | null;
}>;

const parseRows = (rows: Record<string, unknown>[]): AnnouncementRow[] => {
  const parsed: AnnouncementRow[] = [];
  for (const raw of rows) {
    const row = parseRow(AnnouncementRowSchema, raw);
    if (row.isOk()) {
      parsed.push(row.value);
    }
  }
  return parsed;
};

/** Adapt a stored row to the shape the public announcement document builder uses. */
export const announcementFromRow = (row: AnnouncementRow): Announcement => ({
  id: row.id,
  content: row.content,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  allDay: row.all_day !== 0,
  publishedAt: row.published_at,
  updatedAt: row.updated_at,
  reactions: [],
});

export const listAdminAnnouncements = async (
  db: D1Database,
): Promise<Result<AnnouncementRow[], RepositoryError>> =>
  runD1(async () => parseRows(await queryTyped(db, listAdminAnnouncementsSql())));

/** Announcements authored at runtime that are live at `now`. */
export const listPublishedAnnouncements = async (
  db: D1Database,
  now: string,
): Promise<Result<AnnouncementRow[], RepositoryError>> =>
  runD1(async () => parseRows(await queryTyped(db, listPublishedAnnouncementsSql(now))));

export const findAnnouncementRowById = async (
  db: D1Database,
  id: string,
): Promise<Result<AnnouncementRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findAnnouncementByIdSql(id));
    const row = parseRow(AnnouncementRowSchema, rows[0]);
    return row.isOk() ? row.value : undefined;
  });

export const insertAnnouncement = async (
  db: D1Database,
  input: AnnouncementInput,
): Promise<Result<string, RepositoryError>> => {
  const id = newEntityId();
  const written = await runD1(async () => {
    await runTyped(
      db,
      insertAnnouncementSql(
        id,
        input.content,
        input.startsAt,
        input.endsAt,
        input.allDay ? 1 : 0,
        input.publishedAt,
        nowIso(),
      ),
    );
  });
  if (written.isErr()) {
    return err(written.error);
  }
  return ok(id);
};

export const updateAnnouncement = async (
  db: D1Database,
  id: string,
  input: AnnouncementInput,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateAnnouncementSql(
        id,
        input.content,
        input.startsAt,
        input.endsAt,
        input.allDay ? 1 : 0,
        input.publishedAt,
        nowIso(),
      ),
    );
    return rows.length > 0;
  });

export const setAnnouncementPublished = async (
  db: D1Database,
  id: string,
  publishedAt: string | null,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      setAnnouncementPublishedSql(id, publishedAt, nowIso()),
    );
    return rows.length > 0;
  });

export const deleteAnnouncementById = async (
  db: D1Database,
  id: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(db, deleteAnnouncementByIdSql(id));
    return rows.length > 0;
  });
