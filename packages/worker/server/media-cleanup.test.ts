import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { schemaResult } from "@tstodon/core";
import { AccountId, MediaVacuum, StatusesCleanupPolicy } from "@tstodon/domain";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { entityIdAt, newEntityId } from "./ids";
import { newAttachmentObjectKey } from "./media-keys";
import { insertMedia } from "./media-store";
import { vacuumMediaAttachments } from "./media-vacuum";
import { processOutboxJob } from "./outbox-job";
import { handleScheduled } from "./scheduled-handler";
import { saveStatusesCleanupPolicy } from "./statuses-cleanup-store";

const DAY_MS = 24 * 60 * 60 * 1000;

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
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

type SeededMedia = Readonly<{ id: string; objectKey: string; previewKey: string }>;

/** An uploaded image with a preview, both stored in the bucket, `ageDays` old. */
const seedMedia = async (accountId: string, ageDays = 0): Promise<SeededMedia> => {
  const id = newEntityId();
  const objectKey = newAttachmentObjectKey(accountId);
  const previewKey = newAttachmentObjectKey(accountId);
  await env.MEDIA.put(objectKey, new Uint8Array([1, 2, 3]));
  await env.MEDIA.put(previewKey, new Uint8Array([4, 5]));
  const inserted = await insertMedia(env.DB, {
    id,
    accountId,
    objectKey,
    contentType: "image/png",
    description: null,
    focus: null,
    image: {
      original: { width: 40, height: 30 },
      preview: { objectKey: previewKey, dimensions: { width: 40, height: 30 } },
      blurhash: null,
    },
  });
  expect(inserted.isOk()).toBe(true);
  if (ageDays > 0) {
    await env.DB.prepare("UPDATE media_attachments SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - ageDays * DAY_MS).toISOString(), id)
      .run();
  }
  return { id, objectKey, previewKey };
};

const MediaRowState = z.object({ id: z.string(), status_id: z.string().nullable() });

const mediaRow = async (id: string): Promise<z.infer<typeof MediaRowState> | undefined> => {
  const row = await env.DB.prepare("SELECT id, status_id FROM media_attachments WHERE id = ?")
    .bind(id)
    .first();
  return row === null ? undefined : read(MediaRowState, row);
};

const stored = async (media: SeededMedia): Promise<[boolean, boolean]> => [
  (await env.MEDIA.head(media.objectKey)) !== null,
  (await env.MEDIA.head(media.previewKey)) !== null,
];

const expectGone = async (media: SeededMedia): Promise<void> => {
  expect(await mediaRow(media.id)).toBeUndefined();
  expect(await stored(media)).toEqual([false, false]);
};

const expectKept = async (media: SeededMedia): Promise<void> => {
  expect(await mediaRow(media.id)).toBeDefined();
  expect(await stored(media)).toEqual([true, true]);
};

const jsonRequest = async (email: string, method: string, body: unknown): Promise<RequestInit> => ({
  method,
  headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  body: JSON.stringify(body),
});

const postWith = async (email: string, mediaIds: ReadonlyArray<string>): Promise<string> => {
  const response = await call(
    "/api/v1/statuses",
    await jsonRequest(email, "POST", { status: "a picture", media_ids: mediaIds }),
  );
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string() }), await response.json()).id;
};

const deleteStatus = async (email: string, id: string, query = ""): Promise<Response> =>
  call(`/api/v1/statuses/${id}${query}`, {
    method: "DELETE",
    headers: await authHeaders(email),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleting a status", () => {
  it("removes its media rows and both objects with delete_media", async () => {
    const email = "media-cleanup-delete@example.com";
    const accountId = await accountIdOf(email);
    const first = await seedMedia(accountId);
    const second = await seedMedia(accountId);
    const statusId = await postWith(email, [first.id, second.id]);
    expect((await mediaRow(first.id))?.status_id).toBe(statusId);

    const response = await deleteStatus(email, statusId, "?delete_media=true");
    expect(response.status).toBe(200);
    const body = read(
      z.object({ media_attachments: z.array(z.object({ id: z.string() })) }),
      await response.json(),
    );
    expect(body.media_attachments.map((media) => media.id)).toEqual([first.id, second.id]);
    await expectGone(first);
    await expectGone(second);
  });

  it("reads delete_media from a JSON body too", async () => {
    const email = "media-cleanup-delete-body@example.com";
    const accountId = await accountIdOf(email);
    const media = await seedMedia(accountId);
    const statusId = await postWith(email, [media.id]);
    const response = await call(
      `/api/v1/statuses/${statusId}`,
      await jsonRequest(email, "DELETE", { delete_media: true }),
    );
    expect(response.status).toBe(200);
    await expectGone(media);
  });

  it("keeps the media unattached for a redraft without delete_media", async () => {
    const email = "media-cleanup-redraft@example.com";
    const accountId = await accountIdOf(email);
    const media = await seedMedia(accountId);
    const statusId = await postWith(email, [media.id]);

    expect((await deleteStatus(email, statusId, "?delete_media=false")).status).toBe(200);
    await expectKept(media);
    expect((await mediaRow(media.id))?.status_id).toBeNull();

    // The redraft attaches it again.
    const redraft = await postWith(email, [media.id]);
    expect((await mediaRow(media.id))?.status_id).toBe(redraft);
    expect((await deleteStatus(email, redraft)).status).toBe(200);
    await expectKept(media);
  });

  it("also removes media an edit took off the status, which its history still shows", async () => {
    const email = "media-cleanup-edited@example.com";
    const accountId = await accountIdOf(email);
    const before = await seedMedia(accountId);
    const after = await seedMedia(accountId);
    const statusId = await postWith(email, [before.id]);
    const edited = await call(
      `/api/v1/statuses/${statusId}`,
      await jsonRequest(email, "PUT", { status: "another picture", media_ids: [after.id] }),
    );
    expect(edited.status).toBe(200);
    expect((await mediaRow(before.id))?.status_id).toBeNull();

    // The sweep leaves it alone while the history shows it, even once old.
    await env.DB.prepare("UPDATE media_attachments SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 3 * DAY_MS).toISOString(), before.id)
      .run();
    expect((await vacuumMediaAttachments(env)).isOk()).toBe(true);
    await expectKept(before);

    expect((await deleteStatus(email, statusId, "?delete_media=1")).status).toBe(200);
    await expectGone(before);
    await expectGone(after);
  });

  it("removes the media of posts the automated post deletion deletes", async () => {
    const email = "media-cleanup-statuses-cleanup@example.com";
    const accountId = await accountIdOf(email);
    const media = await seedMedia(accountId, 30);
    const at = Date.now() - 30 * DAY_MS;
    const statusId = entityIdAt(at);
    const stamp = new Date(at).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, created_at, updated_at)
         VALUES (?, ?, 'LocalNote', 'old picture', '<p>old picture</p>', 'public', ?, ?)`,
      ).bind(statusId, accountId, stamp, stamp),
      env.DB.prepare("UPDATE media_attachments SET status_id = ?, position = 0 WHERE id = ?").bind(
        statusId,
        media.id,
      ),
    ]);
    const saved = await saveStatusesCleanupPolicy(env.DB, accountId, {
      kind: "Enabled",
      rules: { ...StatusesCleanupPolicy.default.rules, keepMedia: false },
    });
    expect(saved.isOk()).toBe(true);
    const parsedId = AccountId.parse(accountId);
    if (parsedId.isErr()) {
      throw new Error("invalid account id");
    }
    await processOutboxJob(env, { kind: "CleanUpAccountStatuses", accountId: parsedId.value });
    const status = await env.DB.prepare("SELECT id FROM statuses WHERE id = ?")
      .bind(statusId)
      .first();
    expect(status).toBeNull();
    await expectGone(media);
  });
});

describe("the media sweep", () => {
  it("deletes media unattached for over a day and keeps what is still needed", async () => {
    const email = "media-cleanup-sweep@example.com";
    const accountId = await accountIdOf(email);
    const old = await seedMedia(accountId, 2);
    const recent = await seedMedia(accountId);
    const scheduled = await seedMedia(accountId, 2);
    const attached = await seedMedia(accountId, 2);
    await postWith(email, [attached.id]);
    const scheduledAt = new Date(Date.now() + DAY_MS).toISOString();
    const scheduling = await call(
      "/api/v1/statuses",
      await jsonRequest(email, "POST", {
        status: "later",
        media_ids: [scheduled.id],
        scheduled_at: scheduledAt,
      }),
    );
    expect(scheduling.status).toBe(200);

    const pass = await vacuumMediaAttachments(env);
    expect(pass.isOk()).toBe(true);
    await expectGone(old);
    await expectKept(recent);
    await expectKept(scheduled);
    await expectKept(attached);
  });

  it("deletes a bounded batch per pass and queues another after a full one", async () => {
    const email = "media-cleanup-sweep-batch@example.com";
    const accountId = await accountIdOf(email);
    const stamp = new Date(Date.now() - 400 * DAY_MS).toISOString();
    // Older than any other test's media, so this pass takes exactly these.
    const rows = Array.from({ length: MediaVacuum.batch + 1 }, () => ({
      id: newEntityId(),
      key: newAttachmentObjectKey(accountId),
    }));
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare(
          `INSERT INTO media_attachments (id, account_id, object_key, content_type, created_at)
           VALUES (?, ?, ?, 'image/png', ?)`,
        ).bind(row.id, accountId, row.key, stamp),
      ),
    );
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    expect(await processOutboxJob(env, { kind: "VacuumMediaAttachments" })).toBe("ok");
    expect(send).toHaveBeenCalledWith({ kind: "VacuumMediaAttachments" });
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM media_attachments WHERE account_id = ?",
    )
      .bind(accountId)
      .first();
    expect(read(z.object({ count: z.number() }), left).count).toBe(1);
  });

  it("is queued by the six-hourly cron, not the hourly one", async () => {
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
    const fire = async (cron: string) => {
      const ctx = createExecutionContext();
      await handleScheduled(
        { cron, scheduledTime: Date.now(), noRetry: () => undefined },
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    await fire("17 * * * *");
    expect(send).not.toHaveBeenCalledWith({ kind: "VacuumMediaAttachments" });
    await fire("17 */6 * * *");
    expect(send).toHaveBeenCalledWith({ kind: "VacuumMediaAttachments" });
  });
});
