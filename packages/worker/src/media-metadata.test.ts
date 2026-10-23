import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const MediaSchema = z.object({
  id: z.string().min(1),
  description: z.string().nullable(),
  meta: z.object({ focus: z.object({ x: z.number(), y: z.number() }).optional() }),
});

const upload = async (email: string): Promise<z.infer<typeof MediaSchema>> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
  const response = await json("/api/v2/media", {
    method: "POST",
    headers: await auth(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(MediaSchema, response.body);
};

const updateMetadata = async (
  email: string,
  mediaId: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: unknown }> => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return json(`/api/v1/media/${mediaId}`, {
    method: "PUT",
    headers: await auth(email),
    body: form,
  });
};

describe("media metadata", () => {
  it("stores alt text and focus, exposes them on a status, then blocks edits", async () => {
    const email = "media-owner@example.com";
    const media = await upload(email);
    expect(media.description).toBeNull();

    const updated = await updateMetadata(email, media.id, {
      description: "A small test image",
      focus: "-0.25,0.5",
    });
    expect(updated.status).toBe(200);
    const edited = read(MediaSchema, updated.body);
    expect(edited.description).toBe("A small test image");
    expect(edited.meta.focus).toEqual({ x: -0.25, y: 0.5 });

    const status = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "with media", media_ids: [media.id] }),
    });
    expect(status.status).toBe(200);
    const attachments = read(
      z.object({ media_attachments: z.array(MediaSchema) }),
      status.body,
    ).media_attachments;
    expect(attachments[0]?.description).toBe("A small test image");
    expect(attachments[0]?.meta.focus).toEqual({ x: -0.25, y: 0.5 });

    expect((await updateMetadata(email, media.id, { description: "nope" })).status).toBe(422);
    expect(
      (await json(`/api/v1/media/${media.id}`, { method: "DELETE", headers: await auth(email) }))
        .status,
    ).toBe(422);
  });

  it("rejects an invalid focus and editing someone else's media", async () => {
    const email = "media-strict@example.com";
    const media = await upload(email);
    expect((await updateMetadata(email, media.id, { focus: "2,0" })).status).toBe(422);
    expect((await updateMetadata(email, media.id, { focus: "nope" })).status).toBe(422);
    expect(
      (await updateMetadata("media-stranger@example.com", media.id, { description: "hi" })).status,
    ).toBe(404);
    expect(
      (
        await json(`/api/v1/media/${media.id}`, {
          method: "DELETE",
          headers: await auth("media-stranger@example.com"),
        })
      ).status,
    ).toBe(404);
  });

  it("deletes unattached media", async () => {
    const email = "media-deleter@example.com";
    const media = await upload(email);
    const removed = await json(`/api/v1/media/${media.id}`, {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(removed.status).toBe(200);
    expect((await json(`/media/${media.id}`)).status).toBe(404);
    expect(
      (await json(`/api/v1/media/${media.id}`, { method: "DELETE", headers: await auth(email) }))
        .status,
    ).toBe(404);
  });
});
