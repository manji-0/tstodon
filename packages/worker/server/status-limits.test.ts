import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { PNG_40X30, pngChunk } from "../test/image-fixtures";
import { mp4BoxTree, mp4WithMetadata } from "../test/video-fixtures";
import { InstanceLimits } from "@tstodon/core";
import { humanSize, uploadSizeViolation } from "./media-limits";
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

const expectKind = (response: { status: number; body: unknown }, kind: string): void => {
  expect(response.status).toBe(422);
  expect(read(z.object({ kind: z.string() }), response.body).kind).toBe(kind);
};

/** A 422 with exactly this Mastodon error message. */
const expectError = (response: { status: number; body: unknown }, error: string): void => {
  expect(response.status).toBe(422);
  expect(read(z.object({ error: z.string() }), response.body).error).toBe(error);
};

const upload = async (email: string, file: File): Promise<{ status: number; body: unknown }> => {
  const form = new FormData();
  form.set("file", file);
  return json("/api/v2/media", { method: "POST", headers: await auth(email), body: form });
};

/** `PNG_40X30` claiming another size in its IHDR (with a correct CRC). */
const pngSized = (width: number, height: number): Uint8Array => {
  const ihdr = PNG_40X30.slice(16, 29);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  const out = new Uint8Array(PNG_40X30.length);
  out.set(PNG_40X30.subarray(0, 8));
  out.set(pngChunk("IHDR", ihdr), 8);
  out.set(PNG_40X30.subarray(33), 33);
  return out;
};

/**
 * The bare fixture MP4 (four frames) with another video size in its
 * `tkhd` and another `mdhd` timescale, which sets its frame rate: four
 * samples over a duration of 4,000 units.
 */
const mp4Sized = (width: number, height: number, framesPerSecond: number): Uint8Array => {
  const bytes = mp4WithMetadata({ bare: true });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trak = mp4BoxTree(bytes);
  const tkhd = trak.find((box) => box.path === "moov/trak/tkhd");
  const mdhd = trak.find((box) => box.path === "moov/trak/mdia/mdhd");
  if (!tkhd || !mdhd) {
    throw new Error("fixture has no video track");
  }
  view.setUint32(tkhd.end - 8, width * 65536);
  view.setUint32(tkhd.end - 4, height * 65536);
  view.setUint32(mdhd.body + 12, framesPerSecond * 1000);
  view.setUint32(mdhd.body + 16, 4000);
  return bytes;
};

const createStatus = async (
  email: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });

describe("status limits", () => {
  it("rejects text and content warnings over 500 characters", async () => {
    const email = "limits-text@example.com";
    const tooLong = await createStatus(email, { status: "a".repeat(501) });
    expectKind(tooLong, "TooLong");
    expectError(tooLong, "Validation failed: Text character limit of 500 exceeded");

    const atLimit = await createStatus(email, { status: "b".repeat(500) });
    expect(atLimit.status).toBe(200);

    const cw = await createStatus(email, {
      status: "with a long cw",
      spoiler_text: "c".repeat(501),
    });
    expectKind(cw, "TooLong");
  });

  it("counts the content warning and the body together, as Mastodon", async () => {
    const email = "limits-combined@example.com";
    const atLimit = await createStatus(email, {
      status: "a".repeat(250),
      spoiler_text: "c".repeat(250),
    });
    expect(atLimit.status).toBe(200);
    const over = await createStatus(email, {
      status: "a".repeat(251),
      spoiler_text: "c".repeat(250),
    });
    expectKind(over, "TooLong");
  });

  it("counts a URL as characters_reserved_per_url", async () => {
    const email = "limits-url@example.com";
    const url = `https://example.org/${"p".repeat(300)}`;
    const reserved = InstanceLimits.status.charactersReservedPerUrl;
    const filler = (n: number) => "a".repeat(n);
    const atLimit = await createStatus(email, { status: `${filler(500 - reserved - 1)} ${url}` });
    expect(atLimit.status).toBe(200);
    const over = await createStatus(email, { status: `${filler(500 - reserved)} ${url}` });
    expectKind(over, "TooLong");
  });

  it.each([
    ["an emoji with a modifier, a family and a flag", "", "👍🏽 👨‍👩‍👧 🇯🇵", 5],
    ["a URL twitter-text ends before a quote", "", "https://example.com/'quoted'", 24],
    ["a host with no known TLD", "", "http://a.b", 10],
    ["a URL right after the content warning", "CW", "https://example.com", 25],
    ["a URL with a path twitter-text's own pattern ends early", "", "https://例え.jp/パス", 23],
    ["a gemini URL", "", "gemini://example.com/a/long/capsule/path", 23],
    ["a URL inside a match that has no scheme", "", "example.com/https://example.org/a/path", 38],
    ["an xmpp: and a magnet: link", "", "xmpp:alice@example.com magnet:?xt=urn:btih:abc", 46],
  ])("counts %s as the web UI's counter does", async (_, spoilerText, text, length) => {
    const email = "limits-shared-count@example.com";
    const padded = (n: number) => ({
      spoiler_text: spoilerText,
      status: `${text} ${"a".repeat(n - length - 1)}`,
    });
    const max = InstanceLimits.status.maxCharacters;
    expect((await createStatus(email, padded(max))).status).toBe(200);
    expectKind(await createStatus(email, padded(max + 1)), "TooLong");
  });

  it("refuses an edit over the limit", async () => {
    const email = "limits-edit@example.com";
    const created = await createStatus(email, { status: "short" });
    const id = read(z.object({ id: z.string() }), created.body).id;
    const edit = async (status: string) =>
      json(`/api/v1/statuses/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(await auth(email)) },
        body: JSON.stringify({ status }),
      });
    expect((await edit("e".repeat(500))).status).toBe(200);
    expectKind(await edit("e".repeat(501)), "TooLong");
  });

  it("bounds poll option count, option length, and expiry", async () => {
    const email = "limits-poll@example.com";
    const oneOption = await createStatus(email, { status: "poll", poll: { options: ["only"] } });
    expect(oneOption.status).toBe(422);

    const fiveOptions = await createStatus(email, {
      status: "poll",
      poll: { options: ["a", "b", "c", "d", "e"] },
    });
    expect(fiveOptions.status).toBe(422);

    const longOption = await createStatus(email, {
      status: "poll",
      poll: { options: ["ok", "x".repeat(51)] },
    });
    expect(longOption.status).toBe(422);

    const atOptionLimit = await createStatus(email, {
      status: "poll",
      poll: { options: ["ok", "x".repeat(50), "c", "d"] },
    });
    expect(atOptionLimit.status).toBe(200);

    // Outside min_expiration..max_expiration is refused, as Mastodon's
    // PollExpirationValidator (not clamped).
    const poll = (expiresIn: number) =>
      createStatus(email, {
        status: "poll",
        poll: { options: ["yes", "no"], expires_in: expiresIn },
      });
    const { minExpirationSeconds, maxExpirationSeconds } = InstanceLimits.poll;
    expectError(
      await poll(minExpirationSeconds - 1),
      "Validation failed: Poll expires at is too soon",
    );
    expectError(
      await poll(maxExpirationSeconds + 1),
      "Validation failed: Poll expires at is too far into the future",
    );
    const shortest = await poll(minExpirationSeconds);
    expect(shortest.status).toBe(200);
    const remainingMs =
      Date.parse(
        read(z.object({ poll: z.object({ expires_at: z.string().min(1) }) }), shortest.body).poll
          .expires_at,
      ) - Date.now();
    expect(remainingMs).toBeGreaterThan(295_000);
    expect(remainingMs).toBeLessThan(305_000);
    expect((await poll(maxExpirationSeconds)).status).toBe(200);
  });

  it("applies the poll limits to an edited poll", async () => {
    const email = "limits-poll-edit@example.com";
    const created = await createStatus(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    const id = read(z.object({ id: z.string() }), created.body).id;
    const edit = async (poll: Record<string, unknown>) =>
      json(`/api/v1/statuses/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(await auth(email)) },
        body: JSON.stringify({ status: "poll", poll }),
      });
    expectKind(await edit({ options: ["a", "b", "c", "d", "e"] }), "PollOptionsOutOfRange");
    expectKind(await edit({ options: ["a", "x".repeat(51)] }), "PollOptionTooLong");
    expectKind(await edit({ options: ["a", "b"], expires_in: 299 }), "PollExpiration");
    expect((await edit({ options: ["a", "b", "c", "d"], expires_in: 300 })).status).toBe(200);
  });

  it("rejects an over-long media description", async () => {
    const email = "limits-media@example.com";
    const form = new FormData();
    form.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
    const uploaded = await json("/api/v2/media", {
      method: "POST",
      headers: await auth(email),
      body: form,
    });
    const mediaId = read(z.object({ id: z.string().min(1) }), uploaded.body).id;

    const update = new FormData();
    update.set("description", "d".repeat(1501));
    const updated = await json(`/api/v1/media/${mediaId}`, {
      method: "PUT",
      headers: await auth(email),
      body: update,
    });
    expect(updated.status).toBe(422);
  });

  it("refuses uploads over the advertised size limits", async () => {
    const { imageSizeLimit, videoSizeLimit } = InstanceLimits.media;
    // Rails' number_to_human_size, as Paperclip's message prints the limit.
    expect(humanSize(imageSizeLimit)).toBe("16 MB");
    expect(humanSize(videoSizeLimit)).toBe("99 MB");
    expect(uploadSizeViolation("image/png", imageSizeLimit)).toBeUndefined();
    expect(uploadSizeViolation("image/png", imageSizeLimit + 1)).toBe(
      "Validation failed: File file size must be less than 16 MB",
    );
    expect(uploadSizeViolation("video/mp4", videoSizeLimit)).toBeUndefined();
    expect(uploadSizeViolation("video/webm", videoSizeLimit + 1)).toBe(
      "Validation failed: File file size must be less than 99 MB",
    );
    // A video may be larger than an image.
    expect(uploadSizeViolation("video/mp4", imageSizeLimit + 1)).toBeUndefined();

    const tooLarge = new Uint8Array(imageSizeLimit + 1);
    tooLarge.set(PNG_40X30);
    expectError(
      await upload(
        "limits-size@example.com",
        new File([tooLarge], "big.png", { type: "image/png" }),
      ),
      "Validation failed: File file size must be less than 16 MB",
    );
  });

  it("refuses images over image_matrix_limit", async () => {
    const email = "limits-matrix@example.com";
    // 7680 x 4320 is exactly the limit.
    const atLimit = await upload(
      email,
      new File([pngSized(7680, 4320)], "8k.png", { type: "image/png" }),
    );
    expect(atLimit.status).toBe(200);
    expectError(
      await upload(email, new File([pngSized(7681, 4320)], "big.png", { type: "image/png" })),
      "7681x4320 images are not supported",
    );
  });

  it("refuses videos over video_matrix_limit and video_frame_rate_limit", async () => {
    const email = "limits-video@example.com";
    const mp4 = (bytes: Uint8Array) => new File([bytes], "clip.mp4", { type: "video/mp4" });
    // 3840 x 2160 at 120 fps is exactly the limit.
    expect((await upload(email, mp4(mp4Sized(3840, 2160, 120)))).status).toBe(200);
    expectError(
      await upload(email, mp4(mp4Sized(3841, 2160, 30))),
      "3841x2160 videos are not supported",
    );
    expectError(
      await upload(email, mp4(mp4Sized(1920, 1080, 121))),
      "121fps videos are not supported",
    );
  });

  it("advertises the enforced limits on /api/v2/instance", async () => {
    const response = await json("/api/v2/instance");
    expect(response.status).toBe(200);
    const instance = read(
      z.object({
        configuration: z.object({
          accounts: z.object({
            max_featured_tags: z.number(),
            max_pinned_statuses: z.number(),
          }),
          statuses: z.object({
            max_characters: z.number(),
            max_media_attachments: z.number(),
          }),
          polls: z.object({ max_options: z.number(), min_expiration: z.number() }),
          media_attachments: z.object({ description_limit: z.number() }),
          translation: z.object({ enabled: z.boolean() }),
          limited_federation: z.boolean(),
          urls: z.object({
            streaming: z.string().min(1),
            about: z.string().nullable(),
            privacy_policy: z.string().nullable(),
            terms_of_service: z.string().nullable(),
          }),
        }),
        thumbnail: z.object({ url: z.string().min(1), description: z.string().optional() }),
        registrations: z.object({
          enabled: z.boolean(),
          approval_required: z.boolean(),
          reason_required: z.boolean(),
          min_age: z.number(),
          url: z.string().nullable(),
        }),
      }),
      response.body,
    );
    expect(instance.configuration.statuses.max_characters).toBe(500);
    expect(instance.configuration.statuses.max_media_attachments).toBe(4);
    expect(instance.configuration.accounts.max_pinned_statuses).toBe(5);
    expect(instance.configuration.accounts.max_featured_tags).toBe(10);
    expect(instance.configuration.polls.max_options).toBe(4);
    expect(instance.configuration.polls.min_expiration).toBe(300);
    expect(instance.configuration.media_attachments.description_limit).toBe(1500);
    expect(instance.configuration.translation.enabled).toBe(false);
    expect(instance.configuration.limited_federation).toBe(false);
    // Policy documents are configured in the test environment, so their URLs are published.
    expect(instance.configuration.urls.privacy_policy).toContain("/privacy-policy");
    expect(instance.configuration.urls.terms_of_service).toContain("/terms-of-service");
    expect(instance.configuration.urls.streaming.startsWith("wss://")).toBe(true);
    expect(instance.thumbnail.description).toBe("tstodon instance thumbnail");
    expect(instance.registrations.min_age).toBe(16);
    expect(instance.registrations.reason_required).toBe(false);
  });
});
