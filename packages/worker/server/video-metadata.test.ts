import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { UploadMetadata, VideoMetadata, type StrippedVideo } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { containsText, jpegWithMetadata } from "../test/image-fixtures";
import {
  chunkOffsets,
  ebml,
  ebmlHeader,
  ebmlTree,
  EXIF_ITEM_SECRET,
  fragmentedMp4WithMetadata,
  liveWebmWithMetadata,
  mp4Box,
  mp4BoxTree,
  MP4_TIME,
  mp4WithMetadata,
  VIDEO_SECRETS,
  videoFrame,
  WEBM_IDS,
  webmWithMetadata,
  withFileMeta,
  type Mp4BoxInfo,
} from "../test/video-fixtures";

const strip = (bytes: Uint8Array): StrippedVideo => {
  const result = VideoMetadata.strip(bytes);
  if (result.isErr() || result.value.kind !== "Stripped") {
    throw new Error(`not stripped: ${JSON.stringify(result)}`);
  }
  return result.value;
};

const malformedReason = (bytes: Uint8Array): string | undefined => {
  const result = VideoMetadata.strip(bytes);
  return result.isErr() ? result.error.reason : undefined;
};

const SECRET_TEXTS = [...Object.values(VIDEO_SECRETS), "139.6917", EXIF_ITEM_SECRET];

const expectNoSecrets = (bytes: Uint8Array): void => {
  for (const secret of SECRET_TEXTS) {
    expect(containsText(bytes, secret), secret).toBe(false);
  }
};

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const boxAt = (tree: ReadonlyArray<Mp4BoxInfo>, path: string): Mp4BoxInfo => {
  const found = tree.find((box) => box.path === path);
  if (!found) {
    throw new Error(`no ${path}`);
  }
  return found;
};

const isZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

/** The sample sizes of the n-th track's `stsz`. */
const sampleSizes = (bytes: Uint8Array, track: number): ReadonlyArray<number> => {
  const stsz = mp4BoxTree(bytes).filter((box) => box.path === "moov/trak/mdia/minf/stbl/stsz")[
    track
  ];
  if (!stsz) {
    throw new Error("no stsz");
  }
  const data = view(bytes);
  return Array.from({ length: data.getUint32(stsz.body + 8) }, (_, i) =>
    data.getUint32(stsz.body + 12 + i * 4),
  );
};

/** The creation and modification times of the version 0 mvhd, tkhd and mdhd boxes. */
const headerTimes = (bytes: Uint8Array): ReadonlyArray<number> =>
  mp4BoxTree(bytes)
    .filter((box) => /(mvhd|tkhd|mdhd)$/.test(box.path))
    .flatMap((box) =>
      bytes[box.body] === 1
        ? [view(bytes).getUint32(box.body + 8), view(bytes).getUint32(box.body + 16)]
        : [view(bytes).getUint32(box.body + 4), view(bytes).getUint32(box.body + 8)],
    );

describe("VideoMetadata.strip: MP4", () => {
  it("frees user data, QuickTime keys, XMP and the GPS track in place", () => {
    const input = mp4WithMetadata();
    for (const secret of SECRET_TEXTS.slice(0, 7)) {
      expect(containsText(input, secret), secret).toBe(true);
    }

    const out = strip(input);

    expect(out.format).toBe("mp4");
    expect(out.bytes.length).toBe(input.length);
    expectNoSecrets(out.bytes);
    const before = mp4BoxTree(input);
    const after = mp4BoxTree(out.bytes);
    expect(after.filter((box) => !box.path.includes("/")).map((box) => box.path)).toEqual([
      "ftyp",
      "moov",
      "free",
      "mdat",
    ]);
    expect(after.filter((box) => /^moov\/[^/]+$/.test(box.path)).map((box) => box.path)).toEqual([
      "moov/mvhd",
      "moov/trak",
      "moov/free",
      "moov/free",
      "moov/free",
    ]);
    // Every remaining box is where it was, and the video track is whole.
    for (const box of after) {
      expect(
        before.some((old) => old.start === box.start && old.end === box.end),
        box.path,
      ).toBe(true);
    }
    expect(after.map((box) => box.path)).toContain("moov/trak/mdia/minf/stbl/stco");
    expect(after.map((box) => box.path)).not.toContain("moov/trak/udta");
    // The video samples are still where stco says, byte for byte.
    const [videoChunks, gpsChunks] = [chunkOffsets(input)[0] ?? [], chunkOffsets(input)[1] ?? []];
    expect(chunkOffsets(out.bytes)).toEqual([videoChunks]);
    const frameAt = (chunk: number, index: number): Uint8Array => {
      const start = (videoChunks[chunk] ?? 0) + (index % 2) * videoFrame(0).length;
      return out.bytes.subarray(start, start + videoFrame(index).length);
    };
    [0, 1, 2, 3].forEach((index) => {
      expect(frameAt(Math.floor(index / 2), index)).toEqual(videoFrame(index));
    });
    // The GPS samples are zeroed.
    const gpsSizes = sampleSizes(input, 1);
    gpsChunks.forEach((offset, index) => {
      expect(isZero(out.bytes.subarray(offset, offset + (gpsSizes[index] ?? 0)))).toBe(true);
    });
    // Two tracks in the input, the GPS track freed in the output.
    expect(headerTimes(input)).toEqual(Array.from({ length: 10 }, () => MP4_TIME));
    expect(headerTimes(out.bytes)).toEqual([0, 0, 0, 0, 0, 0]);
    // The rest of mvhd, such as its timescale, stays.
    expect(view(out.bytes).getUint32(boxAt(after, "moov/mvhd").body + 12)).toBe(1000);
    expect(out.bytes.subarray(boxAt(after, "moov/trak/mdia/hdlr").body + 8).subarray(0, 4)).toEqual(
      Uint8Array.of(0x76, 0x69, 0x64, 0x65),
    );
  });

  it("handles 64-bit sizes, version 1 headers, co64 and moov after mdat", () => {
    const input = mp4WithMetadata({ faststart: false, large: true });

    const out = strip(input);

    expect(out.bytes.length).toBe(input.length);
    expectNoSecrets(out.bytes);
    const after = mp4BoxTree(out.bytes);
    expect(after.filter((box) => !box.path.includes("/")).map((box) => box.path)).toEqual([
      "ftyp",
      "free",
      "mdat",
      "moov",
    ]);
    expect(boxAt(after, "mdat").body - boxAt(after, "mdat").start).toBe(16);
    expect(after.map((box) => box.path)).toContain("moov/trak/mdia/minf/stbl/co64");
    const [videoChunks] = chunkOffsets(out.bytes);
    const first = videoChunks?.[0] ?? 0;
    expect(out.bytes.subarray(first, first + videoFrame(0).length)).toEqual(videoFrame(0));
    expect(headerTimes(out.bytes)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("changes nothing but the times of an MP4 without metadata", () => {
    const input = mp4WithMetadata({ bare: true });

    const out = strip(input);

    const changed = out.bytes.reduce(
      (count, byte, index) => count + (byte === input[index] ? 0 : 1),
      0,
    );
    // Three boxes, two four-byte times each, every byte of 0xE1234567 non-zero.
    expect(changed).toBe(3 * 2 * 4);
    expect(headerTimes(out.bytes)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("keeps a fragmented MP4 playable and drops its GPS fragments", () => {
    const input = fragmentedMp4WithMetadata();
    expect(containsText(input, VIDEO_SECRETS.trackGps)).toBe(true);

    const out = strip(input);

    expect(out.bytes.length).toBe(input.length);
    expectNoSecrets(out.bytes);
    const after = mp4BoxTree(out.bytes);
    expect(after.filter((box) => /^moof\/[^/]+$/.test(box.path)).map((box) => box.path)).toEqual([
      "moof/mfhd",
      "moof/traf",
      "moof/free",
      "moof/free",
    ]);
    expect(after.filter((box) => box.path === "moov/mvex/trex")).toHaveLength(2);
    // The video run still points at its frames.
    const trun = boxAt(after, "moof/traf/trun");
    const moof = boxAt(after, "moof");
    const dataOffset = view(out.bytes).getInt32(trun.body + 8);
    expect(
      out.bytes.subarray(moof.start + dataOffset, moof.start + dataOffset + videoFrame(0).length),
    ).toEqual(videoFrame(0));
    const mdat = boxAt(after, "mdat");
    const gpsStart = mdat.body + videoFrame(0).length + videoFrame(1).length;
    expect(isZero(out.bytes.subarray(gpsStart, mdat.end))).toBe(true);
    expect(out.bytes.subarray(mdat.body, gpsStart)).toEqual(input.subarray(mdat.body, gpsStart));
  });

  it("blanks the EXIF item of a file-level item store and frees file-level iTunes metadata", () => {
    const heif = withFileMeta(mp4WithMetadata(), "pict");
    expect(containsText(heif, EXIF_ITEM_SECRET)).toBe(true);
    const outHeif = strip(heif);
    expectNoSecrets(outHeif.bytes);
    expect(outHeif.bytes.length).toBe(heif.length);
    expect(
      mp4BoxTree(outHeif.bytes)
        .filter((box) => !box.path.includes("/"))
        .map((box) => box.path),
    ).toEqual(["ftyp", "moov", "free", "mdat", "meta", "mdat"]);

    const itunes = withFileMeta(mp4WithMetadata(), "mdir");
    const outItunes = strip(itunes);
    expectNoSecrets(outItunes.bytes);
    expect(
      mp4BoxTree(outItunes.bytes)
        .filter((box) => !box.path.includes("/"))
        .map((box) => box.path),
    ).toEqual(["ftyp", "moov", "free", "mdat", "free"]);
  });

  it("keeps a file whose last mdat is cut short, zeroing what is left of the GPS samples", () => {
    const input = mp4WithMetadata();
    for (const cut of [5, 30, 60]) {
      const out = strip(input.subarray(0, input.length - cut));
      expect(out.bytes.length).toBe(input.length - cut);
      expectNoSecrets(out.bytes);
    }
  });

  it("refuses an MP4 it cannot walk", () => {
    const ftyp = input4cc("ftyp");
    expect(malformedReason(joinBytes(ftyp, mp4Box("mdat", videoFrame(0))))).toBe(
      "has no movie box",
    );
    const atEnd = mp4WithMetadata({ faststart: false });
    expect(malformedReason(atEnd.subarray(0, atEnd.length - 10))).toBe("a box runs past the end");
    expect(malformedReason(atEnd.subarray(0, atEnd.length - 3))).toBe("a box runs past the end");

    // A user data box that claims more than its parent holds.
    const input = mp4WithMetadata();
    const udta = boxAt(mp4BoxTree(input), "moov/udta");
    const overflowing = input.slice();
    view(overflowing).setUint32(udta.start, udta.end - udta.start + 1000);
    expect(malformedReason(overflowing)).toBe("a box runs past the end");

    const tiny = input.slice();
    view(tiny).setUint32(boxAt(mp4BoxTree(input), "moov").start, 4);
    expect(malformedReason(tiny)).toBe("a box is smaller than its header");

    // A GPS chunk that points into moov instead of mdat.
    const stray = input.slice();
    const gpsStco = mp4BoxTree(input).filter(
      (box) => box.path === "moov/trak/mdia/minf/stbl/stco",
    )[1];
    view(stray).setUint32((gpsStco?.body ?? 0) + 8, 40);
    expect(malformedReason(stray)).toBe("a metadata sample lies outside mdat");
  });
});

const input4cc = (type: string): Uint8Array =>
  mp4Box(
    type,
    Uint8Array.from("isom\0\0\0\0isom", (c) => c.charCodeAt(0)),
  );

const joinBytes = (...pieces: ReadonlyArray<Uint8Array>): Uint8Array =>
  Uint8Array.from(pieces.flatMap((piece) => [...piece]));

/** The ids of the elements directly inside the first element with `parentId`. */
const childIds = (bytes: Uint8Array, parentId: number): ReadonlyArray<number> => {
  const tree = ebmlTree(bytes);
  const parent = tree.find((element) => element.id === parentId);
  const depth = (path: string): number => path.split("/").length;
  return parent
    ? tree
        .filter(
          (element) =>
            element.path.startsWith(`${parent.path}/`) &&
            depth(element.path) === depth(parent.path) + 1,
        )
        .map((element) => element.id)
    : [];
};

describe("VideoMetadata.strip: WebM", () => {
  it("voids Tags, Attachments, the title, date and file name, and the track name in place", () => {
    const input = webmWithMetadata();
    for (const secret of [VIDEO_SECRETS.title, VIDEO_SECRETS.location, VIDEO_SECRETS.cover]) {
      expect(containsText(input, secret), secret).toBe(true);
    }

    const out = strip(input);

    expect(out.format).toBe("webm");
    expect(out.bytes.length).toBe(input.length);
    expectNoSecrets(out.bytes);
    expect(childIds(out.bytes, WEBM_IDS.segment)).toEqual([
      WEBM_IDS.seekHead,
      WEBM_IDS.info,
      WEBM_IDS.tracks,
      WEBM_IDS.cluster,
      WEBM_IDS.cluster,
      WEBM_IDS.cues,
      WEBM_IDS.void,
      WEBM_IDS.void,
    ]);
    // The Info CRC-32, title, date and file name are voided; the rest stays.
    expect(childIds(out.bytes, WEBM_IDS.info)).toEqual([
      WEBM_IDS.void,
      0x2ad7b1,
      WEBM_IDS.muxingApp,
      WEBM_IDS.writingApp,
      WEBM_IDS.void,
      WEBM_IDS.void,
      WEBM_IDS.void,
    ]);
    expect(childIds(out.bytes, 0xae)).toEqual([0xd7, 0x73c5, 0x83, 0x86, WEBM_IDS.void, 0xe0]);
    // The Seek entries for Tags and Attachments are voided; the others still
    // point at their element, as the Cues still point at the first Cluster.
    expect(childIds(out.bytes, WEBM_IDS.seekHead)).toEqual([
      0x4dbb,
      0x4dbb,
      0x4dbb,
      WEBM_IDS.void,
      WEBM_IDS.void,
    ]);
    const tree = ebmlTree(out.bytes);
    const segmentBody = tree.find((element) => element.id === WEBM_IDS.segment)?.body ?? 0;
    const positions = tree.filter((element) => element.id === 0x53ac);
    const idAt = (position: number): number => view(out.bytes).getUint32(segmentBody + position);
    expect(positions.map((element) => idAt(view(out.bytes).getUint32(element.body)))).toEqual([
      WEBM_IDS.info,
      WEBM_IDS.tracks,
      WEBM_IDS.cues,
    ]);
    const cluster = tree.find((element) => element.id === 0xf1);
    expect(idAt(view(out.bytes).getUint32(cluster?.body ?? 0))).toBe(WEBM_IDS.cluster);
    // Every element is where it was, and the clusters are byte for byte.
    const before = ebmlTree(input);
    for (const element of tree.filter((e) => e.path.split("/").length <= 3)) {
      expect(before.some((old) => old.start === element.start && old.end === element.end)).toBe(
        true,
      );
    }
    for (const element of before.filter(
      (e) => e.id === WEBM_IDS.cluster || e.id === WEBM_IDS.cues,
    )) {
      expect(out.bytes.subarray(element.start, element.end)).toEqual(
        input.subarray(element.start, element.end),
      );
    }
    // Voided payloads are zeroed.
    const voids = tree.filter((element) => element.id === WEBM_IDS.void);
    expect(voids.every((element) => isZero(out.bytes.subarray(element.body, element.end)))).toBe(
      true,
    );
  });

  it("strips a live recording whose Segment and Clusters have no size", () => {
    const input = liveWebmWithMetadata();

    const out = strip(input);

    expect(out.bytes.length).toBe(input.length);
    expectNoSecrets(out.bytes);
    expect(containsText(out.bytes, "VIDEO-FRAME-0-")).toBe(true);
    expect(containsText(out.bytes, "VIDEO-FRAME-1-")).toBe(true);
    // The Tags after the last Cluster end it, and are voided.
    const tagsAt = findBytes(input, Uint8Array.of(0x12, 0x54, 0xc3, 0x67));
    expect(out.bytes[tagsAt]).toBe(WEBM_IDS.void);

    // A recording cut inside its last Cluster is kept.
    const cut = input.subarray(0, tagsAt - 3);
    const outCut = strip(cut);
    expect(outCut.bytes.length).toBe(cut.length);
    expectNoSecrets(outCut.bytes);
  });

  it("takes Matroska, and refuses other EBML documents and broken files", () => {
    expect(strip(webmWithMetadata("matroska")).format).toBe("webm");
    expect(malformedReason(webmWithMetadata("other"))).toBe("not a Matroska or WebM document");

    const input = webmWithMetadata();
    const info = ebmlTree(input).find((element) => element.id === WEBM_IDS.info);
    expect(malformedReason(input.subarray(0, (info?.start ?? 0) + 6))).toBe(
      "an element runs past the segment",
    );
    const header = ebmlHeader("webm");
    expect(
      malformedReason(
        joinBytes(
          header,
          ebml(WEBM_IDS.segment, ebml(WEBM_IDS.info, ebml(0x2ad7b1, Uint8Array.of(1)))),
        ),
      ),
    ).toBe("a segment has no Tracks");
    expect(malformedReason(joinBytes(header, Uint8Array.of(0, 1, 2)))).toBe(
      "an invalid element id",
    );
    expect(malformedReason(header)).toBe("has no segment");
    // A Tags element of unknown size cannot be voided.
    const live = liveWebmWithMetadata();
    const tagsAt = findBytes(live, Uint8Array.of(0x12, 0x54, 0xc3, 0x67));
    const unsized = live.slice();
    unsized.set([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], tagsAt + 4);
    expect(malformedReason(unsized)).toBe("an element runs past the segment");
  });
});

const findBytes = (bytes: Uint8Array, needle: Uint8Array): number => {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (needle.every((value, offset) => bytes[i + offset] === value)) {
      return i;
    }
  }
  return -1;
};

describe("VideoMetadata.strip: damaged input", () => {
  const fixtures = [
    mp4WithMetadata(),
    mp4WithMetadata({ faststart: false, large: true }),
    fragmentedMp4WithMetadata(),
    withFileMeta(mp4WithMetadata(), "pict"),
    webmWithMetadata(),
    liveWebmWithMetadata(),
  ];

  it("never throws and never passes on metadata for any truncation", () => {
    for (const input of fixtures) {
      for (let length = 0; length <= input.length; length += 3) {
        const result = VideoMetadata.strip(input.subarray(0, length));
        if (result.isOk() && result.value.kind === "Stripped") {
          expectNoSecrets(result.value.bytes);
        }
      }
    }
  });

  it("never throws on corrupted bytes", () => {
    let seed = 54321;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (const input of fixtures) {
      for (let round = 0; round < 300; round++) {
        const corrupted = input.slice();
        for (let flips = 0; flips < 4; flips++) {
          corrupted[next() % corrupted.length] = next() % 256;
        }
        expect(() => VideoMetadata.strip(corrupted)).not.toThrow();
      }
    }
  });

  it("calls other bytes an unknown format", () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(1, 2, 3), jpegWithMetadata()]) {
      expect(VideoMetadata.strip(bytes)._unsafeUnwrap()).toEqual({ kind: "UnknownFormat" });
    }
  });
});

describe("UploadMetadata.forUpload", () => {
  it("strips videos by their bytes and refuses a declared type the bytes are not", () => {
    const mp4 = mp4WithMetadata();
    const webm = webmWithMetadata();
    for (const [type, bytes] of [
      ["video/mp4", mp4],
      ["video/webm", webm],
      ["video/mp4", webm],
      ["image/gif", mp4],
    ] as const) {
      const stored = UploadMetadata.forUpload(type, bytes)._unsafeUnwrap();
      expect(stored.length).toBe(bytes.length);
      expectNoSecrets(stored);
    }
    for (const [type, bytes] of [
      ["video/mp4", jpegWithMetadata()],
      ["video/webm", Uint8Array.of(1, 2, 3)],
      ["image/png", mp4],
    ] as const) {
      expect(UploadMetadata.forUpload(type, bytes)._unsafeUnwrapErr()).toEqual({
        kind: "NotTheDeclaredType",
        contentType: type,
      });
    }
    expect(UploadMetadata.forUpload("video/mp4", mp4.subarray(0, 100))._unsafeUnwrapErr()).toEqual({
      kind: "MalformedVideo",
      format: "mp4",
      reason: "a box runs past the end",
    });
  });
});

// --- Uploads -----------------------------------------------------------------

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
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const uploadForm = (bytes: Uint8Array, name: string, type: string): FormData => {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type }));
  return form;
};

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

describe("video metadata on upload", () => {
  it("stores MP4 and WebM uploads without their metadata, at the same size", async () => {
    const email = "media-strip-video@example.com";
    for (const [bytes, type, name] of [
      [mp4WithMetadata(), "video/mp4", "phone.mp4"],
      [fragmentedMp4WithMetadata(), "video/mp4", "camera.mp4"],
      [webmWithMetadata(), "video/webm", "clip.webm"],
      [liveWebmWithMetadata(), "video/webm", "recording.webm"],
    ] as const) {
      const response = await json("/api/v2/media", {
        method: "POST",
        headers: await authHeaders(email),
        body: uploadForm(bytes, name, type),
      });
      expect(response.status).toBe(200);
      const media = read(z.object({ type: z.string(), url: z.string() }), response.body);
      expect(media.type).toBe("video");
      const object = await env.MEDIA.get(new URL(media.url).pathname.replace(/^\//, ""));
      const stored = new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
      expect(object?.size).toBe(bytes.length);
      expect(object?.httpMetadata?.contentType).toBe(type);
      expect(stored).toEqual(strip(bytes).bytes);
      expectNoSecrets(stored);
    }
  });

  it("refuses a video it cannot read and stores nothing", async () => {
    const email = "media-strip-video-refused@example.com";
    const accountId = await accountIdOf(email);
    const atEnd = mp4WithMetadata({ faststart: false });
    for (const [bytes, type] of [
      [atEnd.subarray(0, atEnd.length - 10), "video/mp4"],
      [jpegWithMetadata(), "video/mp4"],
      [webmWithMetadata("other"), "video/webm"],
      [Uint8Array.of(1, 2, 3), "video/webm"],
    ] as const) {
      const refused = await json("/api/v2/media", {
        method: "POST",
        headers: await authHeaders(email),
        body: uploadForm(bytes, "broken", type),
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({
        error: `file is not a readable ${type} file`,
        kind: "ValidationError",
      });
    }
    expect(await storedKeys(accountId)).toEqual([]);
  });

  it("refuses a video sent as an avatar image", async () => {
    const email = "media-strip-video-avatar@example.com";
    const form = new FormData();
    form.set("avatar", new File([mp4WithMetadata()], "avatar.png", { type: "image/png" }));
    const refused = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: await authHeaders(email),
      body: form,
    });
    expect(refused.status).toBe(422);
  });
});
