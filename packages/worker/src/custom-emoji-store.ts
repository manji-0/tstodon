import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { customEmojiJson, type CustomEmoji } from "./emoji";
import {
  deleteCustomEmoji as deleteCustomEmojiSql,
  findCustomEmojiById as findCustomEmojiByIdSql,
  findCustomEmojiByShortcode as findCustomEmojiByShortcodeSql,
  insertCustomEmoji as insertCustomEmojiSql,
  listCustomEmojiRows as listCustomEmojiRowsSql,
  replaceCustomEmojiImage as replaceCustomEmojiImageSql,
  updateCustomEmojiAttributes as updateCustomEmojiAttributesSql,
} from "./generated/prisma/sql";
import { customEmojis as configuredCustomEmojis } from "./runtime-config";
import { parseRow } from "./d1";
import { queryTyped, runTyped } from "./typed-sql";

export const CustomEmojiRowSchema = z.object({
  id: z.string().min(1),
  shortcode: z.string().min(1),
  object_key: z.string().min(1),
  content_type: z.string().min(1),
  visible_in_picker: z.number(),
  category: z.string().nullable(),
});

export type CustomEmojiRow = z.infer<typeof CustomEmojiRowSchema>;

const objectUrl = (mediaPublicBaseUrl: string, objectKey: string): string =>
  `${mediaPublicBaseUrl.replace(/\/$/, "")}/${objectKey}`;

export const customEmojiFromRow = (
  row: CustomEmojiRow,
  mediaPublicBaseUrl: string,
): CustomEmoji => {
  const url = objectUrl(mediaPublicBaseUrl, row.object_key);
  const emoji: CustomEmoji = {
    shortcode: row.shortcode,
    url,
    static_url: url,
    visible_in_picker: row.visible_in_picker !== 0,
  };
  return row.category ? { ...emoji, category: row.category } : emoji;
};

export const adminCustomEmojiJson = (
  row: CustomEmojiRow,
  mediaPublicBaseUrl: string,
): Record<string, unknown> => ({
  id: row.id,
  ...customEmojiJson(customEmojiFromRow(row, mediaPublicBaseUrl)),
});

export const listCustomEmojiRows = async (
  db: D1Database,
): Promise<Result<CustomEmojiRow[], RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, listCustomEmojiRowsSql());
    const parsed: CustomEmojiRow[] = [];
    for (const raw of rows) {
      const row = parseRow(CustomEmojiRowSchema, raw);
      if (row.isOk()) {
        parsed.push(row.value);
      }
    }
    return parsed;
  });

const findOne = async (
  db: D1Database,
  typed: { readonly sql: string; readonly values: ReadonlyArray<unknown> },
): Promise<Result<CustomEmojiRow | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, typed);
    const row = parseRow(CustomEmojiRowSchema, rows[0]);
    return row.isOk() ? row.value : undefined;
  });

export const findCustomEmojiRowById = async (
  db: D1Database,
  id: string,
): Promise<Result<CustomEmojiRow | undefined, RepositoryError>> =>
  findOne(db, findCustomEmojiByIdSql(id));

export const findCustomEmojiRowByShortcode = async (
  db: D1Database,
  shortcode: string,
): Promise<Result<CustomEmojiRow | undefined, RepositoryError>> =>
  findOne(db, findCustomEmojiByShortcodeSql(shortcode));

export const insertCustomEmoji = async (
  db: D1Database,
  input: {
    id: string;
    shortcode: string;
    objectKey: string;
    contentType: string;
    visibleInPicker: boolean;
    category: string | null;
  },
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await runTyped(
      db,
      insertCustomEmojiSql(
        input.id,
        input.shortcode,
        input.objectKey,
        input.contentType,
        input.visibleInPicker ? 1 : 0,
        input.category,
        nowIso(),
      ),
    );
  });

export const updateCustomEmojiAttributes = async (
  db: D1Database,
  id: string,
  visibleInPicker: boolean,
  category: string | null,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      updateCustomEmojiAttributesSql(id, visibleInPicker ? 1 : 0, category, nowIso()),
    );
    return rows.length > 0;
  });

export const replaceCustomEmojiImage = async (
  db: D1Database,
  id: string,
  objectKey: string,
  contentType: string,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ id: string }>(
      db,
      replaceCustomEmojiImageSql(id, objectKey, contentType, nowIso()),
    );
    return rows.length > 0;
  });

/** Delete a custom emoji, returning its object key so the caller can drop the image. */
export const deleteCustomEmoji = async (
  db: D1Database,
  id: string,
): Promise<Result<string | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ object_key: string }>(db, deleteCustomEmojiSql(id));
    return rows[0]?.object_key;
  });

/**
 * Custom emojis for this instance: the `CUSTOM_EMOJIS` var plus admin-managed
 * rows (a row with the same shortcode wins). A DB failure degrades to config.
 */
export const loadCustomEmojis = async (
  env: Env,
  mediaPublicBaseUrl: string,
): Promise<ReadonlyArray<CustomEmoji>> => {
  const merged = new Map<string, CustomEmoji>();
  for (const emoji of configuredCustomEmojis(env)) {
    merged.set(emoji.shortcode.toLowerCase(), emoji);
  }
  const rows = await listCustomEmojiRows(env.DB);
  if (rows.isErr()) {
    return [...merged.values()];
  }
  for (const row of rows.value) {
    merged.set(row.shortcode.toLowerCase(), customEmojiFromRow(row, mediaPublicBaseUrl));
  }
  return [...merged.values()];
};

/** Normalize an admin-supplied shortcode: drop colons, lowercase. */
export const normalizeShortcode = (raw: string): string =>
  raw.trim().replace(/^:/, "").replace(/:$/, "").toLowerCase();

export const isValidShortcode = (shortcode: string): boolean => /^[a-z0-9_]+$/.test(shortcode);
