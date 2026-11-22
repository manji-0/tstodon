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
import { CUSTOM_EMOJI_MAX_BYTES } from "./body-limit";
import { newEntityId } from "./ids";
import { humanSize } from "./media-limits";

/**
 * What both the admin API (`/api/v1/admin/custom_emojis`) and the admin web
 * pages (`/admin/custom_emojis`) do to the emojis: store the image in the
 * media bucket under `emoji/` and keep a row for it.
 */

/** Why an emoji image is refused: its type, or its size over Mastodon's 256 KB. */
export type EmojiImageRejected =
  | Readonly<{ kind: "UnsupportedImage" }>
  | Readonly<{ kind: "ImageTooLarge" }>;

export type UploadEmojiError =
  | Readonly<{ kind: "InvalidShortcode" }>
  | Readonly<{ kind: "ImageRequired" }>
  | EmojiImageRejected
  | Readonly<{ kind: "ShortcodeTaken" }>
  | RepositoryError;

/** Mastodon's wording for the errors that mean a field was wrong. */
export const UPLOAD_EMOJI_ERRORS = {
  InvalidShortcode: "shortcode is invalid",
  ImageRequired: "image is required",
  UnsupportedImage: "image must be a PNG, GIF or WebP file",
  ImageTooLarge: `image must be less than ${humanSize(CUSTOM_EMOJI_MAX_BYTES)}`,
  ShortcodeTaken: "shortcode has already been taken",
} as const satisfies Record<Exclude<UploadEmojiError["kind"], "RepositoryError">, string>;

/**
 * The types an emoji's image may have: Mastodon's, and APNG. The Worker can
 * serve the image from the instance's own origin (`getEmojiById`), where an
 * SVG or HTML document would run its script.
 */
const EMOJI_IMAGE_TYPES: ReadonlyArray<string> = [
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
];

/** `contentType` when an emoji's image may have it, parameters dropped. */
export const emojiImageType = (contentType: string): string | undefined => {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return EMOJI_IMAGE_TYPES.includes(type) ? type : undefined;
};

/** Why `image` cannot be an emoji's image, or undefined when it can. */
const rejectEmojiImage = (image: File): EmojiImageRejected | undefined => {
  if (emojiImageType(image.type) === undefined) {
    return { kind: "UnsupportedImage" };
  }
  return image.size > CUSTOM_EMOJI_MAX_BYTES ? { kind: "ImageTooLarge" } : undefined;
};

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
  const rejected = rejectEmojiImage(input.image);
  const contentType = emojiImageType(input.image.type);
  if (rejected !== undefined || contentType === undefined) {
    return err(rejected ?? { kind: "UnsupportedImage" });
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

/** Delete an image no row names; one that stays is only unused storage, so a failure is logged. */
const deleteEmojiObject = async (env: Env, objectKey: string): Promise<void> => {
  try {
    await env.MEDIA.delete(objectKey);
  } catch {
    console.error(JSON.stringify({ kind: "EmojiImageNotDeleted", objectKey }));
  }
};

/**
 * Change an emoji: `undefined` leaves a field alone, `null` clears the
 * category. `undefined` in the result means there is no such emoji. A new
 * image of a type an emoji may not have is refused before anything is written.
 */
export const changeCustomEmoji = async (
  env: Env,
  id: string,
  changes: Readonly<{
    visibleInPicker: boolean | undefined;
    category: string | null | undefined;
    image: File | undefined;
  }>,
): Promise<Result<CustomEmojiRow | undefined, EmojiImageRejected | RepositoryError>> => {
  const rejected = changes.image ? rejectEmojiImage(changes.image) : undefined;
  if (rejected !== undefined) {
    return err(rejected);
  }
  const imageType = changes.image ? emojiImageType(changes.image.type) : undefined;
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
  if (changes.image && imageType !== undefined) {
    // A new image goes under a new key, so its URL changes: Mastodon fetches
    // a remote emoji's image again only when the tag names another URL
    // (`process_emoji`), and the image is cached for good wherever it went.
    const contentType = imageType;
    const objectKey = `emoji/${newEntityId()}`;
    const bytes = await changes.image.arrayBuffer();
    const stored = await env.MEDIA.put(objectKey, bytes, {
      httpMetadata: { contentType },
    });
    const replaced = await replaceCustomEmojiImage(
      env.DB,
      id,
      objectKey,
      contentType,
      stored?.size ?? bytes.byteLength,
    );
    if (replaced.isErr()) {
      await deleteEmojiObject(env, objectKey);
      return err(replaced.error);
    }
    await deleteEmojiObject(env, row.value.object_key);
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
