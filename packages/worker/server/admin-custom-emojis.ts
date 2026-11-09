import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import {
  type CustomEmojiRow,
  deleteCustomEmoji,
  findCustomEmojiRowById,
  findCustomEmojiRowByShortcode,
  insertCustomEmoji,
  isValidShortcode,
  loadCustomEmojis,
  normalizeShortcode,
  replaceCustomEmojiImage,
  updateCustomEmojiAttributes,
} from "./custom-emoji-store";
import { newEntityId } from "./ids";

/**
 * What both the admin API (`/api/v1/admin/custom_emojis`) and the admin web
 * pages (`/admin/custom_emojis`) do to the emojis: store the image in the
 * media bucket under `emoji/` and keep a row for it.
 */

export type UploadEmojiError =
  | Readonly<{ kind: "InvalidShortcode" }>
  | Readonly<{ kind: "ImageRequired" }>
  | Readonly<{ kind: "ShortcodeTaken" }>
  | RepositoryError;

/** Mastodon's wording for the errors that mean a field was wrong. */
export const UPLOAD_EMOJI_ERRORS = {
  InvalidShortcode: "shortcode is invalid",
  ImageRequired: "image is required",
  ShortcodeTaken: "shortcode has already been taken",
} as const satisfies Record<Exclude<UploadEmojiError["kind"], "RepositoryError">, string>;

const contentTypeOf = (image: File): string =>
  image.type.length > 0 ? image.type : "application/octet-stream";

/** A file part of a form that holds bytes; an empty file input sends none. */
export const uploadedFile = (value: unknown): File | undefined =>
  typeof File !== "undefined" && value instanceof File && value.size > 0 ? value : undefined;

/** Store a new emoji's image and row. The shortcode is unique across rows and the `CUSTOM_EMOJIS` var. */
export const uploadCustomEmoji = async (
  env: Env,
  mediaPublicBaseUrl: string,
  input: Readonly<{
    shortcode: string;
    image: File | undefined;
    visibleInPicker: boolean;
    category: string | null;
  }>,
): Promise<Result<CustomEmojiRow, UploadEmojiError>> => {
  const shortcode = normalizeShortcode(input.shortcode);
  if (!isValidShortcode(shortcode)) {
    return err({ kind: "InvalidShortcode" });
  }
  if (!input.image) {
    return err({ kind: "ImageRequired" });
  }
  const existing = await findCustomEmojiRowByShortcode(env.DB, shortcode);
  if (existing.isErr()) {
    return err(existing.error);
  }
  const configured = await loadCustomEmojis(env, mediaPublicBaseUrl);
  if (existing.value || configured.some((emoji) => emoji.shortcode.toLowerCase() === shortcode)) {
    return err({ kind: "ShortcodeTaken" });
  }
  const id = newEntityId();
  const objectKey = `emoji/${id}`;
  const contentType = contentTypeOf(input.image);
  const bytes = await input.image.arrayBuffer();
  const stored = await env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType },
  });
  const inserted = await insertCustomEmoji(env.DB, {
    id,
    shortcode,
    objectKey,
    contentType,
    imageFileSize: stored?.size ?? bytes.byteLength,
    visibleInPicker: input.visibleInPicker,
    category: input.category,
  });
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  const row = await findCustomEmojiRowById(env.DB, id);
  if (row.isErr()) {
    return err(row.error);
  }
  return row.value
    ? ok(row.value)
    : err({ kind: "RepositoryError", message: "emoji missing after insert" });
};

/**
 * Change an emoji: `undefined` leaves a field alone, `null` clears the
 * category. `undefined` in the result means there is no such emoji.
 */
export const changeCustomEmoji = async (
  env: Env,
  id: string,
  changes: Readonly<{
    visibleInPicker: boolean | undefined;
    category: string | null | undefined;
    image: File | undefined;
  }>,
): Promise<Result<CustomEmojiRow | undefined, RepositoryError>> => {
  const row = await findCustomEmojiRowById(env.DB, id);
  if (row.isErr() || !row.value) {
    return row;
  }
  if (changes.visibleInPicker !== undefined || changes.category !== undefined) {
    const updated = await updateCustomEmojiAttributes(
      env.DB,
      id,
      changes.visibleInPicker ?? row.value.visible_in_picker !== 0,
      changes.category !== undefined ? changes.category : row.value.category,
    );
    if (updated.isErr()) {
      return err(updated.error);
    }
  }
  if (changes.image) {
    const contentType = contentTypeOf(changes.image);
    const bytes = await changes.image.arrayBuffer();
    const stored = await env.MEDIA.put(`emoji/${id}`, bytes, {
      httpMetadata: { contentType },
    });
    const replaced = await replaceCustomEmojiImage(
      env.DB,
      id,
      `emoji/${id}`,
      contentType,
      stored?.size ?? bytes.byteLength,
    );
    if (replaced.isErr()) {
      return err(replaced.error);
    }
  }
  return findCustomEmojiRowById(env.DB, id);
};

/** Delete the emoji's row and its image. `false` when there was no such emoji. */
export const removeCustomEmoji = async (
  env: Env,
  id: string,
): Promise<Result<boolean, RepositoryError>> => {
  const objectKey = await deleteCustomEmoji(env.DB, id);
  if (objectKey.isErr()) {
    return err(objectKey.error);
  }
  if (!objectKey.value) {
    return ok(false);
  }
  await env.MEDIA.delete(objectKey.value);
  return ok(true);
};
