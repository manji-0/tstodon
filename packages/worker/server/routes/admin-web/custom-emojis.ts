import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import {
  changeCustomEmoji,
  removeCustomEmoji,
  UPLOAD_EMOJI_ERRORS,
  uploadCustomEmoji,
  uploadedFile,
} from "../../admin-custom-emojis";
import { type EmojiForm, emojisPage } from "../../admin-content-pages";
import { confirmPage } from "../../admin-pages";
import { errorPage } from "../../auth-pages";
import { customEmojiFromRow, listCustomEmojiRows } from "../../custom-emoji-store";
import { pageRedirect } from "../../page-redirect";
import { parseInstanceIdentity } from "../../runtime-config";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  adminSession,
  badForm,
  notFound,
  noticeOf,
  readParts,
  serverError,
  textParts,
  withNotice,
} from "./shared";

/** Mastodon's `/admin/custom_emojis` page: list, upload, show or hide in the picker, and delete. */

const BLANK_FORM: EmojiForm = { shortcode: "", category: "", visibleInPicker: true };

const EmojiCommandSchema = z.object({
  do: z.union([z.literal("upload"), z.literal("show"), z.literal("hide"), z.literal("delete")]),
  id: z.string().default(""),
  shortcode: z.string().trim().default(""),
  category: z.string().trim().default(""),
});

const renderEmojis = async (
  c: SettingsContext,
  mediaPublicBaseUrl: string,
  form: EmojiForm,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const rows = await listCustomEmojiRows(c.env.DB);
  if (rows.isErr()) {
    return serverError(c, rows.error);
  }
  return c.html(
    emojisPage(
      instanceName(c.env),
      {
        emojis: rows.value.map((row) => ({
          id: row.id,
          shortcode: row.shortcode,
          url: customEmojiFromRow(row, mediaPublicBaseUrl).url,
          category: row.category,
          visibleInPicker: row.visible_in_picker !== 0,
        })),
        form,
      },
      message,
    ),
    status,
  );
};

/** Mastodon's `GET /admin/custom_emojis`. */
export const getAdminCustomEmojis = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const identity = parseInstanceIdentity(c.env);
  return identity.isErr()
    ? c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500)
    : renderEmojis(c, identity.value.mediaPublicBaseUrl, BLANK_FORM, noticeOf(c));
};

/** Upload, show, hide, or (after a confirmation) delete one emoji. */
export const postAdminCustomEmojis = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  const parts = await readParts(c);
  const command = schemaResult(EmojiCommandSchema)({
    do: textParts(parts, "do")[0],
    id: textParts(parts, "id")[0],
    shortcode: textParts(parts, "shortcode")[0],
    category: textParts(parts, "category")[0],
  });
  if (command.isErr()) {
    return badForm(c);
  }
  const { value } = command;
  switch (value.do) {
    case "upload": {
      const visibleInPicker = textParts(parts, "visible_in_picker")[0] === "1";
      const uploaded = await uploadCustomEmoji(c.env, identity.value.mediaPublicBaseUrl, {
        shortcode: value.shortcode,
        image: uploadedFile(parts.image),
        visibleInPicker,
        category: value.category.length > 0 ? value.category : null,
      });
      if (uploaded.isOk()) {
        return pageRedirect(c, withNotice("/admin/custom_emojis", "emoji_uploaded"), 303);
      }
      if (uploaded.error.kind === "RepositoryError") {
        return serverError(c, uploaded.error);
      }
      return renderEmojis(
        c,
        identity.value.mediaPublicBaseUrl,
        { shortcode: value.shortcode, category: value.category, visibleInPicker },
        { kind: "error", text: UPLOAD_EMOJI_ERRORS[uploaded.error.kind] },
        422,
      );
    }
    case "show":
    case "hide": {
      const changed = await changeCustomEmoji(c.env, value.id, {
        visibleInPicker: value.do === "show",
        category: undefined,
        image: undefined,
      });
      if (changed.isErr()) {
        return serverError(c, changed.error);
      }
      return changed.value
        ? pageRedirect(
            c,
            withNotice(
              "/admin/custom_emojis",
              value.do === "show" ? "emoji_shown" : "emoji_hidden",
            ),
            303,
          )
        : notFound(c, "emoji");
    }
    case "delete": {
      if (textParts(parts, "confirmed")[0] !== "1") {
        return c.html(
          confirmPage(instanceName(c.env), {
            title: "Delete this emoji?",
            text: "Deleting removes the emoji and its image. Posts that use it show its shortcode instead.",
            action: "/admin/custom_emojis",
            fields: { do: "delete", id: value.id },
            confirmLabel: "Delete",
            cancelHref: "/admin/custom_emojis",
          }),
        );
      }
      const removed = await removeCustomEmoji(c.env, value.id);
      if (removed.isErr()) {
        return serverError(c, removed.error);
      }
      return removed.value
        ? pageRedirect(c, withNotice("/admin/custom_emojis", "emoji_deleted"), 303)
        : notFound(c, "emoji");
    }
  }
};

warmSchemas([EmojiCommandSchema]);
