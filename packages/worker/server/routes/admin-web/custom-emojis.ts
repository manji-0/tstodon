import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { InstanceIdentity } from "@tstodon/domain";
import {
  changeCustomEmoji,
  copyRemoteCustomEmoji,
  removeCustomEmoji,
  UPLOAD_EMOJI_ERRORS,
  uploadCustomEmoji,
  uploadedFile,
} from "../../admin-custom-emojis";
import {
  type EmojiFilterView,
  type EmojiForm,
  emojiListPath,
  emojisPage,
} from "../../admin-content-pages";
import { suspendedDomains } from "../../admin-domain-block-store";
import { confirmPage } from "../../admin-pages";
import { errorPage } from "../../auth-pages";
import type { RepositoryError } from "../../d1";
import {
  customEmojiFromRow,
  listCustomEmojiRows,
  setCustomEmojiDisabled,
} from "../../custom-emoji-store";
import { pageRedirect } from "../../page-redirect";
import {
  deleteRemoteCustomEmojis,
  findRemoteCustomEmojis,
  pageRemoteCustomEmojis,
  type RemoteEmojiKey,
  setRemoteCustomEmojisDisabled,
} from "../../remote-custom-emoji-store";
import { federationAllowHosts, parseInstanceIdentity } from "../../runtime-config";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  adminSession,
  badForm,
  notFound,
  type NoticeKey,
  noticeOf,
  readParts,
  serverError,
  textParts,
  withNotice,
} from "./shared";

/**
 * Mastodon's `/admin/custom_emojis` page: list, upload, show or hide in the
 * picker, enable or disable, and delete the local emoji; list the remote
 * ones, and enable, disable, copy or delete them (`Form::CustomEmojiBatch`).
 * A command that names an `id` is for that local emoji; one that does not is
 * a batch over the remote emoji its `emoji` fields name.
 */

const BLANK_FORM: EmojiForm = { shortcode: "", category: "", visibleInPicker: true };

const EmojiCommandSchema = z.object({
  do: z.union([
    z.literal("upload"),
    z.literal("show"),
    z.literal("hide"),
    z.literal("delete"),
    z.literal("enable"),
    z.literal("disable"),
    z.literal("copy"),
  ]),
  id: z.string().default(""),
  shortcode: z.string().trim().default(""),
  category: z.string().trim().default(""),
});

/**
 * `CustomEmojiFilter`'s keys: `local`, `remote`, `by_domain` (which lists
 * the remote emoji, as the controller sets `remote` for it) and `shortcode`;
 * `after` is where a page of the remote ones starts.
 */
const EmojiFilterSchema = z.object({
  local: z.string().default(""),
  remote: z.string().default(""),
  by_domain: z.string().trim().toLowerCase().default(""),
  shortcode: z.string().trim().default(""),
  after: z.string().default(""),
});

type EmojiFilter = EmojiFilterView & Readonly<{ after: RemoteEmojiKey | undefined }>;

/** A remote emoji named `<domain>/<shortcode>`, as the list's checkboxes and cursor name one. */
const remoteEmojiKey = (value: string): RemoteEmojiKey | undefined => {
  const slash = value.indexOf("/");
  return slash <= 0 || slash === value.length - 1
    ? undefined
    : { domain: value.slice(0, slash), shortcode: value.slice(slash + 1) };
};

const keyText = (key: RemoteEmojiKey): string => `${key.domain}/${key.shortcode}`;

const emojiFilter = (raw: Readonly<Record<string, string | undefined>>): EmojiFilter => {
  const parsed = schemaResult(EmojiFilterSchema)(raw);
  const value = parsed.isOk() ? parsed.value : EmojiFilterSchema.parse({});
  return {
    location:
      value.by_domain !== "" || (value.remote !== "" && value.local === "")
        ? "Remote"
        : value.local !== ""
          ? "Local"
          : "All",
    domain: value.by_domain,
    shortcode: value.shortcode,
    after: remoteEmojiKey(value.after),
  };
};

const renderEmojis = async (
  c: SettingsContext,
  mediaPublicBaseUrl: string,
  filter: EmojiFilter,
  form: EmojiForm,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const [rows, remote] = await Promise.all([
    listCustomEmojiRows(c.env.DB),
    filter.location === "Local"
      ? ok(undefined)
      : pageRemoteCustomEmojis(c.env.DB, filter, filter.after),
  ]);
  if (rows.isErr()) {
    return serverError(c, rows.error);
  }
  if (remote.isErr()) {
    return serverError(c, remote.error);
  }
  const page = remote.value;
  const listing = page && {
    after: filter.after === undefined ? "" : keyText(filter.after),
    entries: page.entries,
    next: page.next && keyText(page.next),
  };
  const shortcode = filter.shortcode.toLowerCase();
  return c.html(
    emojisPage(
      instanceName(c.env),
      {
        filter,
        emojis:
          filter.location === "Remote"
            ? undefined
            : rows.value
                .filter((row) => row.shortcode.toLowerCase().includes(shortcode))
                .map((row) => ({
                  id: row.id,
                  shortcode: row.shortcode,
                  url: customEmojiFromRow(row, mediaPublicBaseUrl).url,
                  category: row.category,
                  visibleInPicker: row.visible_in_picker !== 0,
                  disabled: row.disabled !== 0,
                })),
        remote: listing,
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
    : renderEmojis(
        c,
        identity.value.mediaPublicBaseUrl,
        emojiFilter(c.req.query()),
        BLANK_FORM,
        noticeOf(c),
      );
};

/**
 * Copy each remote emoji `keys` names, one after another; whether all of
 * those held were copied. A local copy that failed leaves the rest to go on,
 * as the next one may come from another server.
 */
const copyRemoteEmojis = async (
  env: Env,
  identity: InstanceIdentity,
  keys: ReadonlyArray<RemoteEmojiKey>,
): Promise<Result<boolean, RepositoryError>> => {
  const emojis = await findRemoteCustomEmojis(env.DB, keys);
  if (emojis.isErr()) {
    return err(emojis.error);
  }
  const options = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  };
  let copiedAll = true;
  for (const emoji of emojis.value) {
    const copied = await copyRemoteCustomEmoji(env, identity, options, emoji);
    if (copied.isErr()) {
      if (copied.error.kind === "RepositoryError") {
        return err(copied.error);
      }
      copiedAll = false;
    }
  }
  return ok(copiedAll);
};

/**
 * A batch action over the remote emoji the form's `emoji` fields name, as
 * `Admin::CustomEmojisController#batch`: back to the list and the page the
 * form was on, with a notice.
 */
const remoteBatch = async (
  c: SettingsContext,
  identity: InstanceIdentity,
  parts: Awaited<ReturnType<typeof readParts>>,
  action: "enable" | "disable" | "copy" | "delete",
) => {
  const filter = emojiFilter({
    local: textParts(parts, "local")[0],
    remote: textParts(parts, "remote")[0],
    by_domain: textParts(parts, "by_domain")[0],
    shortcode: textParts(parts, "shortcode")[0],
    after: textParts(parts, "after")[0],
  });
  const back = (notice: NoticeKey) =>
    pageRedirect(
      c,
      emojiListPath(filter, [
        ...(filter.after === undefined ? [] : [["after", keyText(filter.after)] as const]),
        ["notice", notice],
      ]),
      303,
    );
  const keys = textParts(parts, "emoji").flatMap((key) => remoteEmojiKey(key) ?? []);
  if (keys.length === 0) {
    return back("no_emoji_selected");
  }
  switch (action) {
    case "enable":
    case "disable": {
      const changed = await setRemoteCustomEmojisDisabled(c.env.DB, keys, action === "disable");
      return changed.isErr()
        ? serverError(c, changed.error)
        : back(action === "disable" ? "emojis_disabled" : "emojis_enabled");
    }
    case "copy": {
      const copied = await copyRemoteEmojis(c.env, identity, keys);
      return copied.isErr()
        ? serverError(c, copied.error)
        : back(copied.value ? "emojis_copied" : "emoji_copy_failed");
    }
    case "delete": {
      const deleted = await deleteRemoteCustomEmojis(c.env.DB, keys);
      return deleted.isErr() ? serverError(c, deleted.error) : back("emojis_deleted");
    }
  }
};

/** A command for one local emoji (a delete after a confirmation), or a batch over remote ones. */
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
        emojiFilter({}),
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
        return changed.error.kind === "RepositoryError"
          ? serverError(c, changed.error)
          : badForm(c);
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
    case "enable":
    case "disable": {
      if (value.id === "") {
        return remoteBatch(c, identity.value, parts, value.do);
      }
      const changed = await setCustomEmojiDisabled(c.env.DB, value.id, value.do === "disable");
      if (changed.isErr()) {
        return serverError(c, changed.error);
      }
      return changed.value
        ? pageRedirect(
            c,
            withNotice(
              "/admin/custom_emojis",
              value.do === "disable" ? "emojis_disabled" : "emojis_enabled",
            ),
            303,
          )
        : notFound(c, "emoji");
    }
    case "copy":
      return remoteBatch(c, identity.value, parts, value.do);
    case "delete": {
      if (value.id === "") {
        return remoteBatch(c, identity.value, parts, value.do);
      }
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

warmSchemas([EmojiCommandSchema, EmojiFilterSchema]);
