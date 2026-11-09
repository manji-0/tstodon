import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { schemaResult } from "@tstodon/core";
import { OutboxJob, type OutboxJobValue } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { PNG_40X30, jpegWithMetadata, pngWithMetadata } from "../test/image-fixtures";
import { newEntityId } from "./ids";
import { avatarObjectKey, headerObjectKey, newAttachmentObjectKey } from "./media-keys";
import { backfillStoredMediaSizesPage, storedMediaBytes } from "./media-sizes";
import { vacuumMediaAttachments } from "./media-vacuum";
import { processOutboxJob } from "./outbox-job";
import { handleScheduled } from "./scheduled-handler";

/**
 * The byte sizes recorded for what tstodon stores in `MEDIA` (migration
 * 0125): written by each upload, dropped with the image, and filled in for
 * older rows by `BackfillStoredMediaSizes` from a HEAD of each object.
 */

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

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

/** An attachment stored before sizes were recorded: its objects as given, its sizes NULL. */
const seedUnsized = async (
  accountId: string,
  original: Uint8Array | undefined,
  preview?: Uint8Array,
): Promise<Readonly<{ id: string; objectKey: string; previewKey: string | null }>> => {
  const id = newEntityId();
  const objectKey = newAttachmentObjectKey(accountId);
  const previewKey = preview === undefined ? null : newAttachmentObjectKey(accountId);
  if (original !== undefined) {
    await env.MEDIA.put(objectKey, original);
  }
  if (previewKey !== null && preview !== undefined) {
    await env.MEDIA.put(previewKey, preview);
  }
  await env.DB.prepare(
    `INSERT INTO media_attachments (id, account_id, object_key, preview_object_key, content_type, created_at)
     VALUES (?, ?, ?, ?, 'image/png', ?)`,
  )
    .bind(id, accountId, objectKey, previewKey, new Date().toISOString())
    .run();
  return { id, objectKey, previewKey };
};

const isSizeJob = (
  job: OutboxJobValue,
): job is Extract<OutboxJobValue, { kind: "BackfillStoredMediaSizes" }> =>
  job.kind === "BackfillStoredMediaSizes";

/** Run `BackfillStoredMediaSizes` from the first page until a page queues no other. */
const runBackfill = async (): Promise<ReadonlyArray<OutboxJobValue>> => {
  const queued: OutboxJobValue[] = [];
  vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockImplementation(async (body) => {
    queued.push(OutboxJob.parse(body)._unsafeUnwrap());
    return QUEUED;
  });
  const pages: OutboxJobValue[] = [];
  let job: OutboxJobValue | undefined = OutboxJob.parse({
    kind: "BackfillStoredMediaSizes",
  })._unsafeUnwrap();
  while (job !== undefined) {
    pages.push(job);
    expect(await processOutboxJob(env, job)).toBe("ok");
    job = queued.splice(0).find(isSizeJob);
    expect(pages.length).toBeLessThan(200);
  }
  vi.restoreAllMocks();
  return pages;
};

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

describe("BackfillStoredMediaSizes", () => {
  it("fills unknown sizes from a HEAD of each object, 0 for a missing one, without reading bodies", async () => {
    await runBackfill();
    const accountId = await accountIdOf("sizes-backfill@example.com");
    const withPreview = await seedUnsized(
      accountId,
      new Uint8Array(1500),
      new Uint8Array([1, 2, 3]),
    );
    const missing = await seedUnsized(accountId, undefined);
    const avatarKey = avatarObjectKey(accountId, newEntityId());
    const headerKey = headerObjectKey(accountId, newEntityId());
    await env.MEDIA.put(avatarKey, new Uint8Array(42));
    await env.MEDIA.put(headerKey, new Uint8Array(4200));
    await env.DB.prepare(
      `INSERT INTO account_profiles (account_id, avatar_object_key, avatar_content_type, header_object_key, header_content_type)
       VALUES (?, ?, 'image/png', ?, 'image/png')`,
    )
      .bind(accountId, avatarKey, headerKey)
      .run();
    const emojiId = newEntityId();
    await env.MEDIA.put(`emoji/${emojiId}`, new Uint8Array(77));
    await env.DB.prepare(
      `INSERT INTO custom_emojis (id, shortcode, object_key, content_type)
       VALUES (?, 'unsized_emoji', ?, 'image/png')`,
    )
      .bind(emojiId, `emoji/${emojiId}`)
      .run();
    const get = vi.spyOn(env.MEDIA, "get");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runBackfill();

    expect(get).not.toHaveBeenCalled();
    expect(await mediaSizes(withPreview.id)).toMatchObject({
      file_size: 1500,
      preview_file_size: 3,
    });
    expect(await mediaSizes(missing.id)).toMatchObject({ file_size: 0, preview_file_size: null });
    expect(await profileSizes(accountId)).toMatchObject({
      avatar_file_size: 42,
      header_file_size: 4200,
    });
    expect(await emojiSize(emojiId)).toBe(77);
    expect(warned.mock.calls.map(([line]) => String(line)).join("\n")).toContain(missing.objectKey);
    expect(logged.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "MediaSizeBackfillDone",
    );
  });

  it("keeps a size an upload or rewrite recorded since, and leaves a failed lookup for a later run", async () => {
    await runBackfill();
    const accountId = await accountIdOf("sizes-backfill-deferred@example.com");
    const flaky = await seedUnsized(accountId, new Uint8Array(10));
    const known = await seedUnsized(accountId, new Uint8Array(20), new Uint8Array(5));
    await env.DB.prepare("UPDATE media_attachments SET file_size = 999 WHERE id = ?")
      .bind(known.id)
      .run();
    const head = env.MEDIA.head.bind(env.MEDIA);
    vi.spyOn(env.MEDIA, "head").mockImplementation(async (key) => {
      if (key === flaky.objectKey) {
        throw new Error("R2 unavailable");
      }
      return head(key);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const page = (
      await backfillStoredMediaSizesPage(env, { source: "attachments", afterId: "" })
    )._unsafeUnwrap();
    expect(page.tally.deferred).toBe(1);
    expect((await mediaSizes(flaky.id)).file_size).toBeNull();
    // Only the preview was unknown: the recorded original stays.
    expect(await mediaSizes(known.id)).toMatchObject({ file_size: 999, preview_file_size: 5 });

    vi.restoreAllMocks();
    await runBackfill();
    expect((await mediaSizes(flaky.id)).file_size).toBe(10);
  });

  it("reads a bounded page, resumes from the cursor in the message, and is one empty read once done", async () => {
    await runBackfill();
    const accountId = await accountIdOf("sizes-backfill-pages@example.com");
    const seeded = (
      await Promise.all([1, 2, 3].map((n) => seedUnsized(accountId, new Uint8Array(n))))
    ).toSorted((a, b) => a.id.localeCompare(b.id));

    const first = (
      await backfillStoredMediaSizesPage(env, { source: "attachments", afterId: "" }, 2)
    )._unsafeUnwrap();
    expect(first.scanned).toBe(2);
    expect(first.next).toEqual({ source: "attachments", afterId: seeded[1]?.id });
    expect((await mediaSizes(seeded[2]?.id ?? "")).file_size).toBeNull();

    // The queued message carries the cursor; the page after it finds the last row.
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    expect(
      await processOutboxJob(env, {
        kind: "BackfillStoredMediaSizes",
        source: "attachments",
        afterId: first.next?.afterId ?? "",
        tally: first.tally,
      }),
    ).toBe("ok");
    expect(send).not.toHaveBeenCalled();
    for (const [index, media] of seeded.entries()) {
      expect((await mediaSizes(media.id)).file_size).toBeGreaterThan(0);
      expect((await mediaSizes(media.id)).file_size).toBe(
        await headSize(seeded[index]?.objectKey ?? ""),
      );
    }

    // Done: a run reads nothing, HEADs nothing and queues nothing.
    const head = vi.spyOn(env.MEDIA, "head");
    const done = (
      await backfillStoredMediaSizesPage(env, { source: "attachments", afterId: "" })
    )._unsafeUnwrap();
    expect(done).toMatchObject({ scanned: 0, next: undefined });
    expect(head).not.toHaveBeenCalled();
  });

  it("is queued by the six-hourly cron, not the hourly one", async () => {
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const fire = async (cron: string) => {
      const ctx = createExecutionContext();
      await handleScheduled(
        { cron, scheduledTime: Date.now(), noRetry: () => undefined },
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    };
    const start = { kind: "BackfillStoredMediaSizes", source: "attachments", afterId: "" };
    await fire("17 * * * *");
    expect(send).not.toHaveBeenCalledWith(start);
    await fire("17 */6 * * *");
    expect(send).toHaveBeenCalledWith(start);
  });
});
