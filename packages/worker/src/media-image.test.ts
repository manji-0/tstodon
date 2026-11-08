import { env, SELF } from "cloudflare:test";
import { encode as referenceBlurhash, isBlurhashValid } from "blurhash";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { JPEG_800X600, PNG_40X30 } from "../test/image-fixtures";
import { encodeBlurhash } from "./blurhash";
import { imagesBindingAnalyzer } from "./media-image";
import { decodePng } from "./png-pixels";
import { postV2Media } from "./routes/media";

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

const Size = z.object({
  width: z.number(),
  height: z.number(),
  size: z.string(),
  aspect: z.number(),
});

const Media = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  preview_url: z.string().min(1),
  blurhash: z.string().nullable(),
  meta: z.strictObject({
    original: Size.optional(),
    small: Size.optional(),
    focus: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
});

const uploadForm = (bytes: Uint8Array, name: string, type: string): FormData => {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  return form;
};

const upload = async (
  email: string,
  bytes: Uint8Array,
  name: string,
  type: string,
): Promise<z.infer<typeof Media>> => {
  const response = await json("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: uploadForm(bytes, name, type),
  });
  expect(response.status).toBe(200);
  return read(Media, response.body);
};

/** The R2 key under the media base URL. */
const objectKeyOf = (url: string): string => new URL(url).pathname.replace(/^\//, "");

const accountIdOf = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const storedKeys = async (accountId: string): Promise<ReadonlyArray<string>> =>
  (await env.MEDIA.list({ prefix: `attachments/${accountId}/` })).objects.map(
    (object) => object.key,
  );

/** An Images binding whose every call fails, as when the account has Images disabled. */
const failingImages: ImagesBinding = {
  info: () => Promise.reject(new Error("IMAGES_INFO_ERROR 9523: Images is not enabled")),
  input: () => {
    throw new Error("IMAGES_TRANSFORM_ERROR 9523: Images is not enabled");
  },
  text: () => {
    throw new Error("IMAGES_TRANSFORM_ERROR 9523: Images is not enabled");
  },
  get hosted(): ImagesBinding["hosted"] {
    throw new Error("hosted images are not used");
  },
};

describe("image uploads", () => {
  it("records a PNG's dimensions, stores its small preview, and encodes a blurhash", async () => {
    const email = "media-image-png@example.com";
    const accountId = await accountIdOf(email);

    const media = await upload(email, PNG_40X30, "gradient.png", "image/png");

    const size = { width: 40, height: 30, size: "40x30", aspect: 40 / 30 };
    expect(media.meta).toEqual({ original: size, small: size });
    expect(media.preview_url).not.toBe(media.url);
    const previewKey = objectKeyOf(media.preview_url);
    expect(previewKey).toMatch(new RegExp(`^attachments/${accountId}/[0-9a-f]{32}$`));
    const preview = await env.MEDIA.get(previewKey);
    expect(preview?.httpMetadata?.contentType).toBe("image/webp");
    await preview?.arrayBuffer();
    expect(media.blurhash).not.toBeNull();
    expect(isBlurhashValid(media.blurhash ?? "").result).toBe(true);
    // 4x4 components: one size digit, one maximum digit, four DC and 15 AC pairs.
    expect(media.blurhash).toHaveLength(1 + 1 + 4 + 15 * 2);

    // The stored document reads the same back.
    const fetched = await json(`/api/v1/media/${media.id}`, { headers: await authHeaders(email) });
    expect(read(Media, fetched.body)).toEqual(media);
  });

  it("shrinks a large JPEG's preview to Mastodon's small pixel budget", async () => {
    const email = "media-image-jpeg@example.com";

    const media = await upload(email, JPEG_800X600, "gradient.jpg", "image/jpeg");

    expect(media.meta.original).toEqual({
      width: 800,
      height: 600,
      size: "800x600",
      aspect: 800 / 600,
    });
    const small = media.meta.small;
    expect(small).toBeDefined();
    expect((small?.width ?? 0) * (small?.height ?? 0)).toBeLessThanOrEqual(230_400);
    expect(small?.height).toBe(415);
    expect(small?.width).toBeGreaterThanOrEqual(553);
    expect(small?.size).toBe(`${small?.width}x${small?.height}`);
    expect(media.blurhash).not.toBeNull();
    const preview = await env.MEDIA.get(objectKeyOf(media.preview_url));
    expect(preview).not.toBeNull();
    await preview?.arrayBuffer();
  });

  it("federates the blurhash and the original's width and height", async () => {
    const email = "media-image-note@example.com";
    const media = await upload(email, JPEG_800X600, "note.jpg", "image/jpeg");
    const posted = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status: "a gradient", media_ids: [media.id] }),
    });
    expect(posted.status).toBe(200);
    const status = read(
      z.object({ id: z.string(), account: z.object({ username: z.string() }) }),
      posted.body,
    );

    const note = await json(`/users/${status.account.username}/statuses/${status.id}`, {
      headers: { accept: "application/activity+json" },
    });

    expect(note.status).toBe(200);
    const { attachment } = read(z.object({ attachment: z.array(z.unknown()) }), note.body);
    expect(attachment).toEqual([
      {
        type: "Document",
        mediaType: "image/jpeg",
        url: media.url,
        name: null,
        blurhash: media.blurhash,
        width: 800,
        height: 600,
      },
    ]);
  });

  it("still stores the upload as before when the Images binding fails", async () => {
    const email = "media-image-failing@example.com";
    const accountId = await accountIdOf(email);
    const app = new Hono<{ Bindings: Env }>().post("/api/v2/media", postV2Media);

    const response = await app.request(
      "https://example.com/api/v2/media",
      {
        method: "POST",
        headers: await authHeaders(email),
        body: uploadForm(PNG_40X30, "fallback.png", "image/png"),
      },
      { ...env, IMAGES: failingImages },
    );

    expect(response.status).toBe(200);
    const media = read(Media, await response.json());
    expect(media.meta).toEqual({});
    expect(media.preview_url).toBe(media.url);
    expect(media.blurhash).toBeNull();
    expect(await storedKeys(accountId)).toEqual([objectKeyOf(media.url)]);
  });

  it("keeps a GIF and an unreadable image as they were", async () => {
    const email = "media-image-unprocessed@example.com";
    const gif = await upload(email, new Uint8Array([71, 73, 70]), "a.gif", "image/gif");
    const broken = await upload(email, new Uint8Array([1, 2, 3]), "a.png", "image/png");

    for (const media of [gif, broken]) {
      expect(media.meta).toEqual({});
      expect(media.preview_url).toBe(media.url);
      expect(media.blurhash).toBeNull();
    }
  });

  it("deletes the preview with the media", async () => {
    const email = "media-image-delete@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email, PNG_40X30, "delete.png", "image/png");
    expect(await storedKeys(accountId)).toHaveLength(2);

    const deleted = await json(`/api/v1/media/${media.id}`, {
      method: "DELETE",
      headers: await authHeaders(email),
    });

    expect(deleted.status).toBe(200);
    expect(await storedKeys(accountId)).toEqual([]);
  });
});

describe("imagesBindingAnalyzer", () => {
  it("answers NotAnalyzed instead of throwing when the binding fails or is missing", async () => {
    expect(await imagesBindingAnalyzer(failingImages)(PNG_40X30)).toEqual({
      kind: "NotAnalyzed",
      reason: "IMAGES_INFO_ERROR 9523: Images is not enabled",
    });
    expect(await imagesBindingAnalyzer(undefined)(PNG_40X30)).toEqual({
      kind: "NotAnalyzed",
      reason: "no IMAGES binding",
    });
  });
});

describe("decodePng", () => {
  it("decodes an RGB PNG to RGBA pixels", async () => {
    const decoded = await decodePng(PNG_40X30, 10_000);

    expect(decoded?.width).toBe(40);
    expect(decoded?.height).toBe(30);
    expect(decoded?.pixels.length).toBe(40 * 30 * 4);
    // The fixture's red follows x, green follows y, blue is 200 on the left half.
    expect([...(decoded?.pixels.subarray(0, 4) ?? [])]).toEqual([0, 0, 200, 255]);
    const last = (30 * 40 - 1) * 4;
    expect([...(decoded?.pixels.subarray(last, last + 4) ?? [])]).toEqual([249, 247, 40, 255]);
  });

  it("refuses anything that is not a PNG, or one over the pixel limit", async () => {
    expect(await decodePng(JPEG_800X600, 10_000)).toBeUndefined();
    expect(await decodePng(PNG_40X30, 100)).toBeUndefined();
  });
});

/** RGBA pixels of a gradient, with `red` and `green` as functions of the position. */
const gradient = (
  width: number,
  height: number,
  red: (x: number, y: number) => number,
  green: (x: number, y: number) => number,
): Uint8ClampedArray => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([red(x, y), green(x, y), 128, 255], (y * width + x) * 4);
    }
  }
  return pixels;
};

describe("encodeBlurhash", () => {
  it("matches the reference encoder when the largest AC component is positive", () => {
    // Brightness falling to the right and down makes the first AC components
    // the largest and positive, where the package's signed maximum and the C
    // reference's absolute one agree.
    const pixels = gradient(
      40,
      30,
      (x) => 255 * (1 - x / 40),
      (_, y) => 255 * (1 - y / 30),
    );
    for (const [x, y] of [
      [4, 4],
      [4, 3],
      [9, 9],
      [1, 1],
    ] as const) {
      expect(encodeBlurhash(pixels, 40, 30, x, y)).toBe(referenceBlurhash(pixels, 40, 30, x, y));
    }
  });

  it("scales AC components by their largest magnitude, as the C reference", () => {
    // Brightness rising to the right makes the largest AC component negative,
    // which the package's signed maximum misses, clipping every AC value.
    const pixels = gradient(
      40,
      30,
      (x) => (255 * x) / 40,
      () => 0,
    );
    const hash = encodeBlurhash(pixels, 40, 30, 4, 4);
    const reference = referenceBlurhash(pixels, 40, 30, 4, 4);
    expect(isBlurhashValid(hash).result).toBe(true);
    // The second character is the quantised maximum: larger with the magnitude.
    expect(BASE83.indexOf(hash[1] ?? "")).toBeGreaterThan(BASE83.indexOf(reference[1] ?? ""));
    expect(hash.slice(2, 6)).toBe(reference.slice(2, 6));
  });
});

const BASE83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
