import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { schemaResult } from "@tstodon/core";
import { OutboxJob, StoredMediaMetadata, type OutboxJobValue } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import {
  PNG_40X30,
  SECRETS,
  containsText,
  jpegWithMetadata,
  pngWithMetadata,
  webpWithMetadata,
} from "../test/image-fixtures";
import { VIDEO_SECRETS, mp4WithMetadata } from "../test/video-fixtures";
import { newEntityId } from "./ids";
import { avatarObjectKey, headerObjectKey, newAttachmentObjectKey } from "./media-keys";
import { stripStoredMediaMetadataPage } from "./media-metadata-backfill";
import { processOutboxJob } from "./outbox-job";
import { handleScheduled } from "./scheduled-handler";

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

const MEDIA_BASE = "https://media.example.com";

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

/** An attachment stored before stripping on upload: its bytes as given, its row unmarked. */
const seedAttachment = async (
  accountId: string,
  bytes: Uint8Array,
  contentType: string,
  legacy?: Uint8Array,
): Promise<Readonly<{ id: string; objectKey: string; legacyKey: string | null }>> => {
  const id = newEntityId();
  const objectKey = newAttachmentObjectKey(accountId);
  const legacyKey = legacy === undefined ? null : `attachments/${accountId}/${id}`;
  await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType } });
  if (legacyKey !== null && legacy !== undefined) {
    await env.MEDIA.put(legacyKey, legacy, { httpMetadata: { contentType } });
  }
  await env.DB.prepare(
    `INSERT INTO media_attachments (id, account_id, object_key, legacy_object_key, content_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, accountId, objectKey, legacyKey, contentType, new Date().toISOString())
    .run();
  return { id, objectKey, legacyKey };
};

const objectBytes = async (key: string): Promise<Uint8Array> => {
  const object = await env.MEDIA.get(key);
  if (!object) {
    throw new Error(`no object at ${key}`);
  }
  return new Uint8Array(await object.arrayBuffer());
};

const MarkRow = z.object({
  metadata_stripped_at: z.string().nullable(),
  metadata_strip_error: z.string().nullable(),
});

const attachmentMark = async (id: string): Promise<z.infer<typeof MarkRow>> =>
  read(
    MarkRow,
    await env.DB.prepare(
      "SELECT metadata_stripped_at, metadata_strip_error FROM media_attachments WHERE id = ?",
    )
      .bind(id)
      .first(),
  );

const ProfileMarkRow = z.object({
  avatar_object_key: z.string().nullable(),
  avatar_metadata_stripped_at: z.string().nullable(),
  avatar_metadata_strip_error: z.string().nullable(),
  header_object_key: z.string().nullable(),
  header_metadata_stripped_at: z.string().nullable(),
  header_metadata_strip_error: z.string().nullable(),
});

const profileMark = async (accountId: string): Promise<z.infer<typeof ProfileMarkRow>> =>
  read(
    ProfileMarkRow,
    await env.DB.prepare(
      `SELECT avatar_object_key, avatar_metadata_stripped_at, avatar_metadata_strip_error,
              header_object_key, header_metadata_stripped_at, header_metadata_strip_error
       FROM account_profiles WHERE account_id = ?`,
    )
      .bind(accountId)
      .first(),
  );

/** What the upload path would have stored for `input`. */
const strippedBytes = (input: Uint8Array): Uint8Array => {
  const strip = StoredMediaMetadata.strip(input)._unsafeUnwrap();
  if (strip.kind !== "Stripped") {
    throw new Error("fixture has no metadata");
  }
  return strip.bytes;
};

const isStripJob = (
  job: OutboxJobValue,
): job is Extract<OutboxJobValue, { kind: "StripStoredMediaMetadata" }> =>
  job.kind === "StripStoredMediaMetadata";

/**
 * Run `StripStoredMediaMetadata` from the first page until a page queues no
 * other, as the queue would. Resolves to the pages run.
 */
const runBackfill = async (): Promise<ReadonlyArray<OutboxJobValue>> => {
  const queued: OutboxJobValue[] = [];
  vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockImplementation(async (body) => {
    queued.push(OutboxJob.parse(body)._unsafeUnwrap());
    return QUEUED;
  });
  const pages: OutboxJobValue[] = [];
  let job: OutboxJobValue | undefined = OutboxJob.parse({
    kind: "StripStoredMediaMetadata",
  })._unsafeUnwrap();
  while (job !== undefined) {
    pages.push(job);
    expect(await processOutboxJob(env, job)).toBe("ok");
    job = queued.splice(0).find(isStripJob);
    expect(pages.length).toBeLessThan(200);
  }
  return pages;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StripStoredMediaMetadata", () => {
  it("strips a stored JPEG with GPS EXIF and an MP4 with its location in place, and marks them", async () => {
    const accountId = await accountIdOf("strip-backfill-strips@example.com");
    const jpeg = await seedAttachment(accountId, jpegWithMetadata(6), "image/jpeg");
    const mp4Input = mp4WithMetadata();
    const mp4 = await seedAttachment(accountId, mp4Input, "video/mp4");
    expect(containsText(await objectBytes(jpeg.objectKey), SECRETS.camera)).toBe(true);
    // A copy this data centre's cache holds is dropped with the rewrite.
    const cacheKey = new Request(`${MEDIA_BASE}/${jpeg.objectKey}`);
    await caches.default.put(
      cacheKey,
      new Response("old", { headers: { "cache-control": "public, max-age=31536000" } }),
    );
    expect(await caches.default.match(cacheKey)).toBeDefined();

    await runBackfill();

    const strippedJpeg = await objectBytes(jpeg.objectKey);
    for (const secret of Object.values(SECRETS)) {
      expect(containsText(strippedJpeg, secret), secret).toBe(false);
    }
    expect(strippedJpeg).toEqual(strippedBytes(jpegWithMetadata(6)));
    const strippedMp4 = await objectBytes(mp4.objectKey);
    expect(strippedMp4.length).toBe(mp4Input.length);
    for (const secret of [VIDEO_SECRETS.location, VIDEO_SECRETS.make, VIDEO_SECRETS.model]) {
      expect(containsText(strippedMp4, secret), secret).toBe(false);
    }
    // The content type stays with the object.
    expect((await env.MEDIA.head(mp4.objectKey))?.httpMetadata?.contentType).toBe("video/mp4");
    for (const media of [jpeg, mp4]) {
      const mark = await attachmentMark(media.id);
      expect(mark.metadata_stripped_at).not.toBeNull();
      expect(mark.metadata_strip_error).toBeNull();
    }
    expect(await caches.default.match(cacheKey)).toBeUndefined();
  });

  it("strips the legacy copy the rekey job kept, too", async () => {
    const accountId = await accountIdOf("strip-backfill-legacy@example.com");
    const media = await seedAttachment(
      accountId,
      jpegWithMetadata(),
      "image/jpeg",
      jpegWithMetadata(),
    );
    await runBackfill();
    for (const key of [media.objectKey, media.legacyKey ?? ""]) {
      expect(containsText(await objectBytes(key), SECRETS.camera), key).toBe(false);
    }
    expect((await attachmentMark(media.id)).metadata_stripped_at).not.toBeNull();
  });

  it("leaves clean objects byte for byte and does not write them", async () => {
    const accountId = await accountIdOf("strip-backfill-clean@example.com");
    const cleanJpeg = strippedBytes(jpegWithMetadata(6));
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0]);
    const seeded = [
      await seedAttachment(accountId, cleanJpeg, "image/jpeg"),
      await seedAttachment(accountId, PNG_40X30, "image/png"),
      await seedAttachment(accountId, gif, "image/gif"),
    ];
    const put = vi.spyOn(env.MEDIA, "put");
    await runBackfill();
    const written = put.mock.calls.map(([key]) => key);
    for (const [index, media] of seeded.entries()) {
      expect(written).not.toContain(media.objectKey);
      expect(await objectBytes(media.objectKey)).toEqual([cleanJpeg, PNG_40X30, gif][index]);
      expect((await attachmentMark(media.id)).metadata_stripped_at).not.toBeNull();
    }
  });

  it("leaves an unreadable object as it is, records why, counts it and does not read it again", async () => {
    await runBackfill();
    const accountId = await accountIdOf("strip-backfill-broken@example.com");
    const broken = PNG_40X30.subarray(0, 20);
    const media = await seedAttachment(accountId, broken, "image/png");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const page = (
      await stripStoredMediaMetadataPage(env, { source: "attachments", afterId: "" })
    )._unsafeUnwrap();
    expect(page.tally).toEqual({ ...StoredMediaMetadata.emptyTally, unreadable: 1 });
    expect(await objectBytes(media.objectKey)).toEqual(broken);
    const mark = await attachmentMark(media.id);
    expect(mark.metadata_stripped_at).toBeNull();
    expect(mark.metadata_strip_error).toMatch(/^MalformedImage: /);
    expect(logged.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "MediaMetadataNotStripped",
    );

    const get = vi.spyOn(env.MEDIA, "get");
    await runBackfill();
    expect(get.mock.calls.map(([key]) => key)).not.toContain(media.objectKey);
  });

  it("pages through rows, resumes from the cursor in the message, and moves on to avatars", async () => {
    await runBackfill();
    const accountId = await accountIdOf("strip-backfill-pages@example.com");
    const seeded = [
      await seedAttachment(accountId, jpegWithMetadata(), "image/jpeg"),
      await seedAttachment(accountId, jpegWithMetadata(), "image/jpeg"),
      await seedAttachment(accountId, jpegWithMetadata(), "image/jpeg"),
    ].toSorted((a, b) => a.id.localeCompare(b.id));
    const limits = { ...StoredMediaMetadata.limits, rows: 2 };

    const first = (
      await stripStoredMediaMetadataPage(env, { source: "attachments", afterId: "" }, limits)
    )._unsafeUnwrap();
    expect(first.scanned).toBe(2);
    expect(first.tally.stripped).toBe(2);
    expect(first.next).toEqual({ source: "attachments", afterId: seeded[1]?.id });
    expect((await attachmentMark(seeded[2]?.id ?? "")).metadata_stripped_at).toBeNull();

    // The queued message carries the cursor and the tally so far.
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    expect(
      await processOutboxJob(env, {
        kind: "StripStoredMediaMetadata",
        source: "attachments",
        afterId: first.next?.afterId ?? "",
        tally: first.tally,
      }),
    ).toBe("ok");
    expect(send).toHaveBeenCalledWith({
      kind: "StripStoredMediaMetadata",
      source: "avatars",
      afterId: "",
      tally: { ...StoredMediaMetadata.emptyTally, stripped: 3 },
    });
    expect((await attachmentMark(seeded[2]?.id ?? "")).metadata_stripped_at).not.toBeNull();
  });

  it("strips avatars and headers and marks the profile", async () => {
    const accountId = await accountIdOf("strip-backfill-profile@example.com");
    const avatarKey = avatarObjectKey(accountId, newEntityId());
    const headerKey = headerObjectKey(accountId, newEntityId());
    await env.MEDIA.put(avatarKey, pngWithMetadata(), {
      httpMetadata: { contentType: "image/png" },
    });
    await env.MEDIA.put(headerKey, webpWithMetadata(), {
      httpMetadata: { contentType: "image/webp" },
    });
    await env.DB.prepare(
      `INSERT INTO account_profiles
         (account_id, avatar_object_key, avatar_content_type, header_object_key, header_content_type)
       VALUES (?, ?, 'image/png', ?, 'image/webp')
       ON CONFLICT(account_id) DO UPDATE SET
         avatar_object_key = excluded.avatar_object_key, avatar_content_type = 'image/png',
         header_object_key = excluded.header_object_key, header_content_type = 'image/webp',
         avatar_metadata_stripped_at = NULL, header_metadata_stripped_at = NULL`,
    )
      .bind(accountId, avatarKey, headerKey)
      .run();

    await runBackfill();

    for (const key of [avatarKey, headerKey]) {
      const bytes = await objectBytes(key);
      for (const secret of Object.values(SECRETS)) {
        expect(containsText(bytes, secret), `${key} ${secret}`).toBe(false);
      }
    }
    const mark = await profileMark(accountId);
    expect(mark.avatar_metadata_stripped_at).not.toBeNull();
    expect(mark.header_metadata_stripped_at).not.toBeNull();
    expect(mark.avatar_metadata_strip_error).toBeNull();
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
    const start = { kind: "StripStoredMediaMetadata", source: "attachments", afterId: "" };
    await fire("17 * * * *");
    expect(send).not.toHaveBeenCalledWith(start);
    await fire("17 */6 * * *");
    expect(send).toHaveBeenCalledWith(start);
  });

  it("re-stripping already clean bytes is a no-op", () => {
    for (const input of [
      jpegWithMetadata(6),
      pngWithMetadata(3),
      webpWithMetadata(),
      mp4WithMetadata(),
    ]) {
      const once = StoredMediaMetadata.strip(input)._unsafeUnwrap();
      expect(once.kind).toBe("Stripped");
      if (once.kind === "Stripped") {
        expect(StoredMediaMetadata.strip(once.bytes)._unsafeUnwrap()).toEqual({
          kind: "Unchanged",
        });
      }
    }
  });
});

describe("uploads are marked as stripped when stored", () => {
  it("marks a media upload", async () => {
    const email = "strip-mark-media@example.com";
    const form = new FormData();
    form.set("file", new File([jpegWithMetadata()], "a.jpg", { type: "image/jpeg" }));
    const response = await call("/api/v2/media", {
      method: "POST",
      headers: await authHeaders(email),
      body: form,
    });
    expect(response.status).toBe(200);
    const { id } = read(z.object({ id: z.string().min(1) }), await response.json());
    const mark = await attachmentMark(id);
    expect(mark.metadata_stripped_at).not.toBeNull();
    expect(mark.metadata_strip_error).toBeNull();
  });

  it("marks a new avatar or header, keeps the mark on other profile edits, and clears it with the image", async () => {
    const email = "strip-mark-profile@example.com";
    const accountId = await accountIdOf(email);
    // A profile whose header predates stripping on upload.
    const oldHeader = headerObjectKey(accountId, newEntityId());
    await env.MEDIA.put(oldHeader, webpWithMetadata(), {
      httpMetadata: { contentType: "image/webp" },
    });
    await env.DB.prepare(
      `INSERT INTO account_profiles (account_id, header_object_key, header_content_type)
       VALUES (?, ?, 'image/webp')`,
    )
      .bind(accountId, oldHeader)
      .run();

    const form = new FormData();
    form.set("avatar", new File([pngWithMetadata()], "a.png", { type: "image/png" }));
    const uploaded = await call("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: await authHeaders(email),
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const afterAvatar = await profileMark(accountId);
    expect(afterAvatar.avatar_object_key).not.toBeNull();
    expect(afterAvatar.avatar_metadata_stripped_at).not.toBeNull();
    // The header was not uploaded again, so it still waits for the backfill.
    expect(afterAvatar.header_object_key).toBe(oldHeader);
    expect(afterAvatar.header_metadata_stripped_at).toBeNull();

    const edited = await call("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ note: "edited" }),
    });
    expect(edited.status).toBe(200);
    const afterEdit = await profileMark(accountId);
    expect(afterEdit.avatar_metadata_stripped_at).toBe(afterAvatar.avatar_metadata_stripped_at);
    expect(afterEdit.header_metadata_stripped_at).toBeNull();

    const header = new FormData();
    header.set("header", new File([webpWithMetadata()], "h.webp", { type: "image/webp" }));
    await call("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: await authHeaders(email),
      body: header,
    });
    const afterHeader = await profileMark(accountId);
    expect(afterHeader.header_object_key).not.toBe(oldHeader);
    expect(afterHeader.header_metadata_stripped_at).not.toBeNull();

    const removed = await call("/api/v1/profile/avatar", {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(removed.status).toBe(200);
    const afterRemove = await profileMark(accountId);
    expect(afterRemove.avatar_object_key).toBeNull();
    expect(afterRemove.avatar_metadata_stripped_at).toBeNull();
  });
});
