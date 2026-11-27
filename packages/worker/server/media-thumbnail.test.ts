import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiMediaAttachment } from "@tstodon/api";
import { ApDocument } from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { JPEG_800X600, PNG_40X30 } from "../test/image-fixtures";
import { mp4WithMetadata } from "../test/video-fixtures";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const video = (): File =>
  new File([mp4WithMetadata({ bare: true })], "clip.mp4", { type: "video/mp4" });
const jpeg = (): File => new File([JPEG_800X600], "cover.jpg", { type: "image/jpeg" });
const png = (): File => new File([PNG_40X30], "cover.png", { type: "image/png" });

const formOf = (fields: Readonly<Record<string, File>>): FormData => {
  const form = new FormData();
  for (const [name, file] of Object.entries(fields)) {
    form.set(name, file);
  }
  return form;
};

const upload = async (email: string, fields: Readonly<Record<string, File>>) =>
  json("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: formOf(fields),
  });

const putThumbnail = async (email: string, id: string, thumbnail: File) =>
  json(`/api/v1/media/${id}`, {
    method: "PUT",
    headers: await authHeaders(email),
    body: formOf({ thumbnail }),
  });

/** The R2 key under the media base URL. */
const objectKeyOf = (url: string): string => new URL(url).pathname.replace(/^\//, "");

/** The `meta.small` size of an attachment, whatever its type. */
const smallOf = (meta: unknown) =>
  z.object({ small: z.object({ width: z.number(), height: z.number() }).optional() }).parse(meta)
    .small;

const stored = async (url: string): Promise<string | undefined> => {
  const object = await env.MEDIA.get(objectKeyOf(url));
  await object?.arrayBuffer();
  return object === null ? undefined : (object.httpMetadata?.contentType ?? "");
};

describe("custom thumbnails of video", () => {
  it("stores a thumbnail given with the upload as the preview, at the small size", async () => {
    const response = await upload("thumb-upload@example.com", { file: video(), thumbnail: jpeg() });

    expect(response.status).toBe(200);
    const media = expectContract(ApiMediaAttachment, response.body);
    expect(media.type).toBe("video");
    expect(media.preview_url).not.toBe(media.url);
    const small = smallOf(media.meta);
    expect((small?.width ?? 0) * (small?.height ?? 0)).toBeLessThanOrEqual(230_400);
    expect(small?.height).toBe(415);
    expect(media.blurhash).not.toBeNull();
    expect(await stored(media.preview_url ?? "")).toMatch(/^image\//);
  });

  it("replaces the thumbnail on PUT and deletes the old one, and the attachment's delete deletes it", async () => {
    const email = "thumb-replace@example.com";
    const created = expectContract(
      ApiMediaAttachment,
      (await upload(email, { file: video() })).body,
    );
    expect(created.preview_url).toBe(created.url);

    const first = await putThumbnail(email, created.id, jpeg());
    expect(first.status).toBe(200);
    const withFirst = expectContract(ApiMediaAttachment, first.body);
    expect(withFirst.preview_url).not.toBe(created.url);

    const second = await putThumbnail(email, created.id, png());
    expect(second.status).toBe(200);
    const withSecond = expectContract(ApiMediaAttachment, second.body);
    expect(smallOf(withSecond.meta)).toMatchObject({ width: 40, height: 30 });
    expect(await stored(withFirst.preview_url ?? "")).toBeUndefined();
    expect(await stored(withSecond.preview_url ?? "")).toMatch(/^image\//);

    const removed = await json(`/api/v1/media/${created.id}`, {
      method: "DELETE",
      headers: await authHeaders(email),
    });
    expect(removed.status).toBe(200);
    expect(await stored(withSecond.preview_url ?? "")).toBeUndefined();
  });

  it("removes the thumbnail when PUT sends thumbnail: null", async () => {
    const email = "thumb-clear@example.com";
    const created = expectContract(
      ApiMediaAttachment,
      (await upload(email, { file: video(), thumbnail: png() })).body,
    );

    const cleared = await json(`/api/v1/media/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ thumbnail: null }),
    });

    expect(cleared.status).toBe(200);
    const media = expectContract(ApiMediaAttachment, cleared.body);
    expect(media.preview_url).toBe(media.url);
    expect(media.blurhash).toBeNull();
    expect(await stored(created.preview_url ?? "")).toBeUndefined();
  });

  it("refuses a thumbnail for an image, and one that is not a JPEG, PNG, GIF or WebP", async () => {
    const email = "thumb-refused@example.com";
    expect(await upload(email, { file: png(), thumbnail: png() })).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail must be blank", kind: "ValidationError" },
    });
    const image = expectContract(ApiMediaAttachment, (await upload(email, { file: png() })).body);
    expect((await putThumbnail(email, image.id, png())).status).toBe(422);

    const heic = new File([PNG_40X30], "cover.heic", { type: "image/heic" });
    expect(await upload(email, { file: video(), thumbnail: heic })).toEqual({
      status: 422,
      body: {
        error: "Validation failed: Thumbnail content type is invalid, Thumbnail is invalid",
        kind: "ValidationError",
      },
    });
  });

  it("federates the thumbnail as the attachment's icon", async () => {
    const email = "thumb-note@example.com";
    const media = expectContract(
      ApiMediaAttachment,
      (await upload(email, { file: video(), thumbnail: jpeg() })).body,
    );
    const posted = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status: "a clip", media_ids: [media.id] }),
    });
    expect(posted.status).toBe(200);
    const status = z
      .object({ id: z.string(), account: z.object({ username: z.string() }) })
      .parse(posted.body);

    const note = await json(`/users/${status.account.username}/statuses/${status.id}`, {
      headers: { accept: "application/activity+json" },
    });

    const { attachment } = z.object({ attachment: z.array(z.unknown()) }).parse(note.body);
    const document = expectContract(ApDocument, attachment[0]);
    expect(document.mediaType).toBe("video/mp4");
    expect(document.icon).toEqual({
      type: "Image",
      mediaType: await stored(media.preview_url ?? ""),
      url: media.preview_url,
    });
  });
});
