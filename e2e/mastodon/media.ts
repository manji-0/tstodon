/** The files the sweep uploads, and the upload itself. */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import type { E2eUser } from "../lib.js";
import { call, eventually, Media, StepFailure } from "./sweep.js";

/** A PNG of one colour; 32×32 and red unless told otherwise. */
export const png = (
  rgb: readonly [number, number, number] = [220, 40, 40],
  width = 32,
  height = 32,
): Blob => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(rgb))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
};

/**
 * A one-second 64×64 H.264 MP4, made by the ffmpeg in Mastodon's image.
 * `undefined` when Docker is not reachable from this process.
 */
export const mp4 = (): Blob | undefined => {
  try {
    const bytes = execFileSync(
      "docker",
      [
        ...["compose", "exec", "-T", "web", "ffmpeg", "-loglevel", "error"],
        // Ten black frames: that build has no `lavfi` test source.
        ...["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "64x64", "-r", "10", "-i", "/dev/zero"],
        ...["-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264"],
        ...["-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"],
      ],
      {
        cwd: dirname(fileURLToPath(import.meta.url)),
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
  } catch {
    return undefined;
  }
};

/** Upload a file as `user` and wait until the server has processed it; the attachment's id. */
export const upload = async (
  user: E2eUser,
  description: string,
  options: { file?: Blob; name?: string; focus?: string } = {},
): Promise<string> => {
  const form = new FormData();
  form.set("file", options.file ?? png(), options.name ?? "red.png");
  form.set("description", description);
  if (options.focus !== undefined) {
    form.set("focus", options.focus);
  }
  const media = await call(user, "/api/v2/media", Media, { method: "POST", form });
  await eventually(
    `${user.username}'s upload is processed`,
    async () => {
      const response = await fetch(`${user.origin}/api/v1/media/${media.id}`, {
        headers: user.headers,
      });
      if (response.status >= 400 && response.status !== 404) {
        throw new StepFailure(`the upload failed: ${response.status} ${await response.text()}`);
      }
      return response.status === 200 ? true : undefined;
    },
    60_000,
  );
  return media.id;
};
