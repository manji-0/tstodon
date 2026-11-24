import { SELF, env } from "cloudflare:test";
import { schemaResult } from "@tstodon/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { PNG_40X30, jpegWithMetadata, pngWithMetadata } from "../test/image-fixtures";
import { storedMediaBytes } from "./media-sizes";
import { vacuumMediaAttachments } from "./media-vacuum";

/**
 * The byte sizes recorded for what tstodon stores in `MEDIA`: written by each
 * upload and dropped with the image.
 */

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const call = (path: string, init?: RequestInit): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, init);

const accountIdOf = async (email: string): Promise<string> => {
  const response = await call("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

/** The size R2 holds for `key`, from a HEAD; undefined when nothing is stored. */
const headSize = async (key: string): Promise<number | undefined> =>
  (await env.MEDIA.head(key))?.size;

const MediaSizeRow = z.object({
  object_key: z.string(),
  preview_object_key: z.string().nullable(),
  file_size: z.number().nullable(),
  preview_file_size: z.number().nullable(),
});

const mediaSizes = async (id: string): Promise<z.infer<typeof MediaSizeRow>> =>
  read(
    MediaSizeRow,
    await env.DB.prepare(
      `SELECT object_key, preview_object_key, file_size, preview_file_size
       FROM media_attachments WHERE id = ?`,
    )
      .bind(id)
      .first(),
  );

const ProfileSizeRow = z.object({
  avatar_object_key: z.string().nullable(),
  avatar_file_size: z.number().nullable(),
  header_object_key: z.string().nullable(),
  header_file_size: z.number().nullable(),
});

const profileSizes = async (accountId: string): Promise<z.infer<typeof ProfileSizeRow>> =>
  read(
    ProfileSizeRow,
    await env.DB.prepare(
      `SELECT avatar_object_key, avatar_file_size, header_object_key, header_file_size
       FROM account_profiles WHERE account_id = ?`,
    )
      .bind(accountId)
      .first(),
  );

const emojiSize = async (id: string): Promise<number | null> =>
  read(
    z.object({ image_file_size: z.number().nullable() }),
    await env.DB.prepare("SELECT image_file_size FROM custom_emojis WHERE id = ?").bind(id).first(),
  ).image_file_size;

const uploadMedia = async (email: string, file: File): Promise<string> => {
  const form = new FormData();
  form.set("file", file);
  const response = await call("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

const totalBytes = async () => (await storedMediaBytes(env.DB))._unsafeUnwrap();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sizes recorded on upload", () => {
  it("records the stored original's and preview's sizes, as R2 holds them", async () => {
    const email = "sizes-upload@example.com";
    const before = await totalBytes();
    const id = await uploadMedia(email, new File([PNG_40X30], "a.png", { type: "image/png" }));
    const row = await mediaSizes(id);
    expect(row.preview_object_key).not.toBeNull();
    expect(row.file_size).toBe(await headSize(row.object_key));
    expect(row.preview_file_size).toBe(await headSize(row.preview_object_key ?? ""));
    expect(row.preview_file_size).toBeGreaterThan(0);
    const after = await totalBytes();
    expect(after.attachments - before.attachments).toBe(
      (row.file_size ?? 0) + (row.preview_file_size ?? 0),
    );
  });

  it("records the size of the metadata-stripped bytes, not the upload's", async () => {
    const input = jpegWithMetadata(6);
    const id = await uploadMedia(
      "sizes-upload-stripped@example.com",
      new File([input], "a.jpg", { type: "image/jpeg" }),
    );
    const row = await mediaSizes(id);
    expect(row.file_size).toBe(await headSize(row.object_key));
    expect(row.file_size).toBeLessThan(input.length);
  });

  it("records avatar and header sizes, keeps them on other edits, and clears them with the image", async () => {
    const email = "sizes-profile@example.com";
    const accountId = await accountIdOf(email);
    const form = new FormData();
    form.set("avatar", new File([pngWithMetadata()], "a.png", { type: "image/png" }));
    form.set("header", new File([PNG_40X30], "h.png", { type: "image/png" }));
    const uploaded = await call("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: await authHeaders(email),
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const stored = await profileSizes(accountId);
    expect(stored.avatar_file_size).toBe(await headSize(stored.avatar_object_key ?? ""));
    expect(stored.avatar_file_size).toBeLessThan(pngWithMetadata().length);
    expect(stored.header_file_size).toBe(PNG_40X30.length);

    const edited = await call("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ note: "edited" }),
    });
    expect(edited.status).toBe(200);
    expect(await profileSizes(accountId)).toEqual(stored);

    const removed = await call("/api/v1/profile/avatar", {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(removed.status).toBe(200);
    const afterRemove = await profileSizes(accountId);
    expect(afterRemove.avatar_object_key).toBeNull();
    expect(afterRemove.avatar_file_size).toBeNull();
    expect(afterRemove.header_file_size).toBe(PNG_40X30.length);
  });

  it("records a custom emoji's image size, and drops it with the emoji", async () => {
    const before = await totalBytes();
    const form = new FormData();
    form.set("shortcode", "sized_emoji");
    form.set("image", new File([PNG_40X30], "e.png", { type: "image/png" }));
    const response = await call("/api/v1/admin/custom_emojis", {
      method: "POST",
      headers: await authHeaders("sizes-admin@example.com", { admin: true }),
      body: form,
    });
    expect(response.status).toBe(200);
    const { id } = read(z.object({ id: z.string().min(1) }), await response.json());
    expect(await emojiSize(id)).toBe(PNG_40X30.length);
    expect((await totalBytes()).emojis - before.emojis).toBe(PNG_40X30.length);

    const deleted = await call(`/api/v1/admin/custom_emojis/${id}`, {
      method: "DELETE",
      headers: await authHeaders("sizes-admin@example.com", { admin: true }),
    });
    expect(deleted.status).toBe(200);
    expect((await totalBytes()).emojis).toBe(before.emojis);
  });
});

describe("sizes leave with the media", () => {
  it("deleting an attachment drops its bytes from the sums", async () => {
    const email = "sizes-delete@example.com";
    const before = await totalBytes();
    const id = await uploadMedia(email, new File([PNG_40X30], "a.png", { type: "image/png" }));
    expect((await totalBytes()).attachments).toBeGreaterThan(before.attachments);
    const deleted = await call(`/api/v1/media/${id}`, {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(deleted.status).toBe(200);
    expect((await totalBytes()).attachments).toBe(before.attachments);
  });

  it("the vacuum drops the bytes of the media it deletes", async () => {
    const id = await uploadMedia(
      "sizes-vacuum@example.com",
      new File([PNG_40X30], "a.png", { type: "image/png" }),
    );
    const row = await mediaSizes(id);
    await env.DB.prepare("UPDATE media_attachments SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 3 * 86_400_000).toISOString(), id)
      .run();
    const before = await totalBytes();
    (await vacuumMediaAttachments(env))._unsafeUnwrap();
    expect(before.attachments - (await totalBytes()).attachments).toBeGreaterThanOrEqual(
      (row.file_size ?? 0) + (row.preview_file_size ?? 0),
    );
    expect(await headSize(row.object_key)).toBeUndefined();
  });
});
