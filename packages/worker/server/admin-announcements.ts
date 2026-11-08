import { err, ok, type Result } from "neverthrow";
import {
  type AnnouncementRow,
  findAnnouncementRowById,
  insertAnnouncement,
  updateAnnouncement,
} from "./announcement-admin-store";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";

/**
 * What both the admin API (`/api/v1/admin/announcements`) and the admin web
 * pages (`/admin/announcements`) do with an announcement's fields. A field left
 * `undefined` is unchanged on an edit; `null` clears it.
 */
export type AnnouncementDraft = Readonly<{
  /** Plain text, shown as one paragraph. */
  text?: string | undefined;
  /** HTML; wins over `text` when it is not blank. */
  content?: string | undefined;
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
  allDay?: boolean | undefined;
  /** When to publish; `null` or a past time publishes now. */
  scheduledAt?: string | null | undefined;
}>;

export type AnnouncementError =
  | Readonly<{ kind: "TextRequired" }>
  | Readonly<{ kind: "InvalidWindow" }>
  | Readonly<{ kind: "InvalidSchedule" }>
  | Readonly<{ kind: "NotFound" }>
  | RepositoryError;

/** Mastodon's wording for the errors that mean a field was wrong. */
export const ANNOUNCEMENT_ERRORS = {
  TextRequired: "text is required",
  InvalidWindow: "starts_at and ends_at must be ISO 8601 datetimes",
  InvalidSchedule: "scheduled_at must be an ISO 8601 datetime",
} as const satisfies Record<
  Exclude<AnnouncementError["kind"], "NotFound" | "RepositoryError">,
  string
>;

const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const announcementContent = (draft: AnnouncementDraft): string | undefined => {
  if (typeof draft.content === "string" && draft.content.trim().length > 0) {
    return draft.content;
  }
  if (typeof draft.text === "string") {
    return `<p>${escapeText(draft.text.trim())}</p>`;
  }
  return undefined;
};

/** `null` passes through (clears); a missing value inherits `fallback`. */
const dateField = (
  value: string | null | undefined,
  fallback: string | null,
): string | null | undefined => {
  if (value === undefined) {
    return fallback;
  }
  if (value === null || value.length === 0) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
};

const scheduledPublishedAt = (scheduledAt: string | null): string | undefined => {
  if (scheduledAt === null || scheduledAt.length === 0) {
    return nowIso();
  }
  const parsed = Date.parse(scheduledAt);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed > Date.now() ? new Date(parsed).toISOString() : nowIso();
};

/**
 * Create an announcement. Mastodon's API publishes it at once or at
 * `scheduledAt`; `publish: false` keeps it a draft for an admin to publish.
 */
export const createAnnouncement = async (
  db: D1Database,
  draft: AnnouncementDraft,
  options: Readonly<{ publish: boolean }> = { publish: true },
): Promise<Result<AnnouncementRow, AnnouncementError>> => {
  const content = announcementContent(draft);
  if (content === undefined) {
    return err({ kind: "TextRequired" });
  }
  const startsAt = dateField(draft.startsAt, null);
  const endsAt = dateField(draft.endsAt, null);
  if (startsAt === undefined || endsAt === undefined) {
    return err({ kind: "InvalidWindow" });
  }
  const publishedAt = options.publish ? scheduledPublishedAt(draft.scheduledAt ?? nowIso()) : null;
  if (publishedAt === undefined) {
    return err({ kind: "InvalidSchedule" });
  }
  const created = await insertAnnouncement(db, {
    content,
    startsAt,
    endsAt,
    allDay: draft.allDay ?? false,
    publishedAt,
  });
  if (created.isErr()) {
    return err(created.error);
  }
  const row = await findAnnouncementRowById(db, created.value);
  if (row.isErr()) {
    return err(row.error);
  }
  return row.value ? ok(row.value) : err({ kind: "NotFound" });
};

/** Change an announcement's fields; a field the draft leaves out keeps its value. */
export const changeAnnouncement = async (
  db: D1Database,
  id: string,
  draft: AnnouncementDraft,
): Promise<Result<AnnouncementRow, AnnouncementError>> => {
  const existing = await findAnnouncementRowById(db, id);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (!existing.value) {
    return err({ kind: "NotFound" });
  }
  const startsAt = dateField(draft.startsAt, existing.value.starts_at);
  const endsAt = dateField(draft.endsAt, existing.value.ends_at);
  if (startsAt === undefined || endsAt === undefined) {
    return err({ kind: "InvalidWindow" });
  }
  const publishedAt =
    draft.scheduledAt === undefined
      ? existing.value.published_at
      : scheduledPublishedAt(draft.scheduledAt);
  if (publishedAt === undefined) {
    return err({ kind: "InvalidSchedule" });
  }
  const updated = await updateAnnouncement(db, id, {
    content: announcementContent(draft) ?? existing.value.content,
    startsAt,
    endsAt,
    allDay: draft.allDay ?? existing.value.all_day !== 0,
    publishedAt,
  });
  if (updated.isErr()) {
    return err(updated.error);
  }
  const row = await findAnnouncementRowById(db, id);
  if (row.isErr()) {
    return err(row.error);
  }
  return row.value ? ok(row.value) : err({ kind: "NotFound" });
};
