import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { signUp } from "../test/passkey-browser";
import { processOutboxJob } from "./outbox-job";

const BYTES = [137, 80, 78, 71, 1, 2, 3];

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const fetchPath = (path: string, init?: RequestInit): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init });

const accountIdOf = async (email: string): Promise<string> => {
  const response = await fetchPath("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

const AttachmentSchema = z.object({ id: z.string().min(1), url: z.string().min(1) });

const upload = async (email: string): Promise<z.infer<typeof AttachmentSchema>> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(BYTES)], "a.png", { type: "image/png" }));
  const response = await fetchPath("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(AttachmentSchema, await response.json());
};

const post = async (
  email: string,
  mediaId: string,
  visibility: string,
): Promise<z.infer<typeof AttachmentSchema>> => {
  const response = await fetchPath("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "a picture", media_ids: [mediaId], visibility }),
  });
  expect(response.status).toBe(200);
  const attachment = read(
    z.object({ media_attachments: z.array(AttachmentSchema) }),
    await response.json(),
  ).media_attachments[0];
  if (!attachment) {
    throw new Error("status has no attachment");
  }
  return attachment;
};

const bytesAt = async (url: string): Promise<number[]> => {
  const response = await SELF.fetch(url);
  expect(response.status).toBe(200);
  return [...new Uint8Array(await response.arrayBuffer())];
};

describe("media access", () => {
  it("does not serve a direct post's attachment to someone who knows only its account and id", async () => {
    const email = "media-direct@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const attached = await post(email, media.id, "direct");

    // The id's instant bounds a guess; the stored object must not sit at the guessed key.
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);

    const lastSegment = new URL(attached.url).pathname.split("/").at(-1) ?? "";
    expect(lastSegment).toMatch(/^[0-9a-f]{32}$/);
    expect(await bytesAt(attached.url)).toEqual(BYTES);
  });

  it("gives every upload its own random key", async () => {
    const email = "media-keys@example.com";
    const first = await upload(email);
    const second = await upload(email);
    expect(first.url).not.toBe(second.url);
    expect(first.url).not.toContain(first.id);
  });

  it("redirects /media/:id to the file only for media on a status the viewer may see", async () => {
    const email = "media-public@example.com";
    const media = await upload(email);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);

    const attached = await post(email, media.id, "public");
    const response = await fetchPath(`/media/${media.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(attached.url);

    const privateMedia = await upload(email);
    await post(email, privateMedia.id, "private");
    expect((await fetchPath(`/media/${privateMedia.id}`)).status).toBe(404);
  });

  it("redirects the author's own browser session to media on a private post", async () => {
    const { fetcher } = await signUp("media_owner");
    const email = "media_owner@mail.example";
    const media = await upload(email);
    const attached = await post(email, media.id, "private");

    const response = await fetcher(`/media/${media.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(attached.url);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);
  });
});

const StoredKeysSchema = z.object({
  object_key: z.string(),
  legacy_object_key: z.string().nullable(),
});

const storedKeys = async (
  mediaId: string,
): Promise<z.infer<typeof StoredKeysSchema> | undefined> => {
  const row = await env.DB.prepare(
    "SELECT object_key, legacy_object_key FROM media_attachments WHERE id = ?",
  )
    .bind(mediaId)
    .first();
  return row === null ? undefined : read(StoredKeysSchema, row);
};

/** Put an upload back where attachments were stored before random keys, as migration 0102 finds it. */
const storeAtLegacyKey = async (
  accountId: string,
  mediaId: string,
  rowObjectKey?: string,
): Promise<string> => {
  const legacyKey = `attachments/${accountId}/${mediaId}`;
  const current = await storedKeys(mediaId);
  if (!current) {
    throw new Error("media row missing");
  }
  const object = await env.MEDIA.get(current.object_key);
  if (!object) {
    throw new Error("media object missing");
  }
  await env.MEDIA.put(legacyKey, await object.arrayBuffer(), {
    httpMetadata: object.httpMetadata ?? {},
  });
  if (rowObjectKey === undefined) {
    await env.MEDIA.delete(current.object_key);
  }
  await env.DB.prepare(
    "UPDATE media_attachments SET object_key = ?, legacy_object_key = ? WHERE id = ?",
  )
    .bind(rowObjectKey ?? legacyKey, legacyKey, mediaId)
    .run();
  return legacyKey;
};

const statusAttachmentUrl = async (email: string, statusId: string): Promise<string> => {
  const response = await fetchPath(`/api/v1/statuses/${statusId}`, {
    headers: await authHeaders(email),
  });
  const url = read(
    z.object({ media_attachments: z.array(AttachmentSchema) }),
    await response.json(),
  ).media_attachments[0]?.url;
  if (!url) {
    throw new Error("status has no attachment");
  }
  return url;
};

const postWithId = async (email: string, mediaId: string): Promise<string> => {
  const response = await fetchPath("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "old picture", media_ids: [mediaId], visibility: "direct" }),
  });
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

describe("rekeying attachments stored at an id-derived key", () => {
  it("moves the object to a random key and removes the guessable one", async () => {
    const email = "media-legacy@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const statusId = await postWithId(email, media.id);
    const legacyKey = await storeAtLegacyKey(accountId, media.id);
    expect(await statusAttachmentUrl(email, statusId)).toMatch(
      new RegExp(`/attachments/${accountId}/${media.id}$`),
    );
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(200);

    expect(await processOutboxJob(env, { kind: "RekeyLegacyMedia" })).toBe("ok");

    expect(await env.MEDIA.head(legacyKey)).toBeNull();
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    const url = await statusAttachmentUrl(email, statusId);
    expect(new URL(url).pathname).toMatch(new RegExp(`^/attachments/${accountId}/[0-9a-f]{32}$`));
    expect(await bytesAt(url)).toEqual(BYTES);
    expect((await storedKeys(media.id))?.legacy_object_key).toBeNull();

    expect(await processOutboxJob(env, { kind: "RekeyLegacyMedia" })).toBe("ok");
    expect(await statusAttachmentUrl(email, statusId)).toBe(url);
  });

  it("finishes a move that stopped after the row took its new key", async () => {
    const email = "media-legacy-resume@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const newKey = (await storedKeys(media.id))?.object_key;
    await storeAtLegacyKey(accountId, media.id, newKey);
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(200);

    expect(await processOutboxJob(env, { kind: "RekeyLegacyMedia" })).toBe("ok");

    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    expect(await storedKeys(media.id)).toEqual({ object_key: newKey, legacy_object_key: null });
    expect(await bytesAt(media.url)).toEqual(BYTES);
  });

  it("deletes both objects of unattached media removed before its move", async () => {
    const email = "media-legacy-delete@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const newKey = (await storedKeys(media.id))?.object_key ?? "";
    const legacyKey = await storeAtLegacyKey(accountId, media.id, newKey);

    const removed = await fetchPath(`/api/v1/media/${media.id}`, {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(removed.status).toBe(200);
    expect(await env.MEDIA.head(legacyKey)).toBeNull();
    expect(await env.MEDIA.head(newKey)).toBeNull();
  });
});
