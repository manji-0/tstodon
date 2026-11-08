import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import {
  ANNOUNCEMENT_ERRORS,
  type AnnouncementDraft,
  changeAnnouncement,
  createAnnouncement,
} from "../../admin-announcements";
import {
  type AnnouncementEntry,
  type AnnouncementForm,
  announcementPage,
  announcementsPage,
} from "../../admin-content-pages";
import { confirmPage } from "../../admin-pages";
import {
  type AnnouncementRow,
  deleteAnnouncementById,
  findAnnouncementRowById,
  listAdminAnnouncements,
  setAnnouncementPublished,
} from "../../announcement-admin-store";
import { nowIso } from "../../clock";
import { htmlToText } from "../../html";
import { pageRedirect } from "../../page-redirect";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  adminSession,
  badForm,
  type NoticeKey,
  notFound,
  noticeOf,
  readFields,
  serverError,
  withNotice,
} from "./shared";

/** Mastodon's `/admin/announcements` pages: list, create, edit, publish, and delete. */

const entryOf = (row: AnnouncementRow): AnnouncementEntry => ({
  id: row.id,
  text: htmlToText(row.content),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  allDay: row.all_day !== 0,
  publishedAt: row.published_at,
});

/** The value of a `datetime-local` input for a stored time. */
const inputTime = (time: string | null): string => (time === null ? "" : time.slice(0, 16));

const formOf = (entry: AnnouncementEntry): AnnouncementForm => ({
  text: entry.text,
  startsAt: inputTime(entry.startsAt),
  endsAt: inputTime(entry.endsAt),
  allDay: entry.allDay,
});

const BLANK_FORM: AnnouncementForm = { text: "", startsAt: "", endsAt: "", allDay: false };

/** A `datetime-local` value (UTC) as an ISO time: `null` when blank, `undefined` when unreadable. */
const isoTime = (value: string): string | null | undefined => {
  if (value.length === 0) {
    return null;
  }
  const parsed = new Date(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? `${value}:00Z` : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

const checked = z
  .string()
  .optional()
  .transform((value) => value === "1");

const text = z.string().default("");

const AnnouncementFieldsSchema = z.object({
  text,
  starts_at: text,
  ends_at: text,
  all_day: checked,
  publish: checked,
});

const AnnouncementCommandSchema = z.object({
  do: z.union([
    z.literal("save"),
    z.literal("publish"),
    z.literal("unpublish"),
    z.literal("delete"),
  ]),
});

const formFromFields = (fields: z.infer<typeof AnnouncementFieldsSchema>): AnnouncementForm => ({
  text: fields.text,
  startsAt: fields.starts_at,
  endsAt: fields.ends_at,
  allDay: fields.all_day,
});

/** The draft a form holds, or the message that says which time was unreadable. */
const draftOf = (
  fields: z.infer<typeof AnnouncementFieldsSchema>,
  keepContent: string | undefined,
): AnnouncementDraft | string => {
  if (fields.text.trim().length === 0) {
    return "Enter the announcement's text.";
  }
  const startsAt = isoTime(fields.starts_at);
  const endsAt = isoTime(fields.ends_at);
  if (startsAt === undefined || endsAt === undefined) {
    return "Enter the times as dates and times.";
  }
  return {
    text: fields.text === keepContent ? undefined : fields.text,
    startsAt,
    endsAt,
    allDay: fields.all_day,
  };
};

const renderAnnouncements = async (
  c: SettingsContext,
  form: AnnouncementForm,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const rows = await listAdminAnnouncements(c.env.DB);
  return rows.isErr()
    ? serverError(c, rows.error)
    : c.html(
        announcementsPage(
          instanceName(c.env),
          { announcements: rows.value.map(entryOf), form },
          message,
        ),
        status,
      );
};

const renderAnnouncement = (
  c: SettingsContext,
  entry: AnnouncementEntry,
  form: AnnouncementForm,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => c.html(announcementPage(instanceName(c.env), { entry, form }, message), status);

/** Mastodon's `GET /admin/announcements`. */
export const getAdminAnnouncements = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  return admin.kind === "Answered"
    ? admin.response
    : renderAnnouncements(c, BLANK_FORM, noticeOf(c));
};

/** Mastodon's `POST /admin/announcements`: a new announcement, published unless it is a draft. */
export const postAdminAnnouncements = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const fields = schemaResult(AnnouncementFieldsSchema)(await readFields(c));
  if (fields.isErr()) {
    return badForm(c);
  }
  const form = formFromFields(fields.value);
  const draft = draftOf(fields.value, undefined);
  if (typeof draft === "string") {
    return renderAnnouncements(c, form, { kind: "error", text: draft }, 422);
  }
  const created = await createAnnouncement(c.env.DB, draft, { publish: fields.value.publish });
  if (created.isOk()) {
    return pageRedirect(c, withNotice("/admin/announcements", "announcement_created"), 303);
  }
  if (created.error.kind === "RepositoryError" || created.error.kind === "NotFound") {
    return serverError(c, {
      kind: "RepositoryError",
      message: created.error.kind === "NotFound" ? "announcement missing" : created.error.message,
    });
  }
  return renderAnnouncements(
    c,
    form,
    { kind: "error", text: ANNOUNCEMENT_ERRORS[created.error.kind] },
    422,
  );
};

/** The announcement at the path, or the response that replaces the page. */
const announcementAt = async (c: SettingsContext, id: string) => {
  const row = await findAnnouncementRowById(c.env.DB, id);
  if (row.isErr()) {
    return { kind: "Answered", response: serverError(c, row.error) } as const;
  }
  return row.value
    ? ({ kind: "Found", row: row.value } as const)
    : ({ kind: "Answered", response: notFound(c, "announcement") } as const);
};

/** Mastodon's `GET /admin/announcements/:id/edit`. */
export const getAdminAnnouncement = async (
  c: Context<{ Bindings: Env }, "/admin/announcements/:id">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const found = await announcementAt(c, c.req.param("id"));
  if (found.kind === "Answered") {
    return found.response;
  }
  const entry = entryOf(found.row);
  return renderAnnouncement(c, entry, formOf(entry), noticeOf(c));
};

const PUBLICATION_NOTICES = {
  publish: "announcement_published",
  unpublish: "announcement_unpublished",
} as const satisfies Record<string, NoticeKey>;

/** Save (`do=save`), publish, unpublish, or delete the announcement. */
export const postAdminAnnouncement = async (
  c: Context<{ Bindings: Env }, "/admin/announcements/:id">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const found = await announcementAt(c, c.req.param("id"));
  if (found.kind === "Answered") {
    return found.response;
  }
  const raw = await readFields(c);
  const command = schemaResult(AnnouncementCommandSchema)(raw);
  const fields = schemaResult(AnnouncementFieldsSchema)(raw);
  if (command.isErr() || fields.isErr()) {
    return badForm(c);
  }
  const { row } = found;
  const path = `/admin/announcements/${row.id}`;
  switch (command.value.do) {
    case "publish":
    case "unpublish": {
      const changed = await setAnnouncementPublished(
        c.env.DB,
        row.id,
        command.value.do === "publish" ? nowIso() : null,
      );
      return changed.isErr()
        ? serverError(c, changed.error)
        : pageRedirect(c, withNotice(path, PUBLICATION_NOTICES[command.value.do]), 303);
    }
    case "delete": {
      if (raw.confirmed !== "1") {
        return c.html(
          confirmPage(instanceName(c.env), {
            title: "Delete this announcement?",
            text: "Deleting removes the announcement for everyone. This cannot be undone.",
            action: path,
            fields: { do: "delete" },
            confirmLabel: "Delete",
            cancelHref: path,
          }),
        );
      }
      const removed = await deleteAnnouncementById(c.env.DB, row.id);
      return removed.isErr()
        ? serverError(c, removed.error)
        : pageRedirect(c, withNotice("/admin/announcements", "announcement_deleted"), 303);
    }
    case "save": {
      const entry = entryOf(row);
      const form = formFromFields(fields.value);
      const draft = draftOf(fields.value, entry.text);
      if (typeof draft === "string") {
        return renderAnnouncement(c, entry, form, { kind: "error", text: draft }, 422);
      }
      const saved = await changeAnnouncement(c.env.DB, row.id, draft);
      if (saved.isOk()) {
        return pageRedirect(c, withNotice(path, "announcement_saved"), 303);
      }
      if (saved.error.kind === "NotFound") {
        return notFound(c, "announcement");
      }
      if (saved.error.kind === "RepositoryError") {
        return serverError(c, saved.error);
      }
      return renderAnnouncement(
        c,
        entry,
        form,
        { kind: "error", text: ANNOUNCEMENT_ERRORS[saved.error.kind] },
        422,
      );
    }
  }
};

warmSchemas([AnnouncementFieldsSchema, AnnouncementCommandSchema]);
