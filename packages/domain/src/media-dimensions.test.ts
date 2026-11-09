import { describe, expect, it } from "vite-plus/test";
import { MediaDimensions } from "./media-dimensions";

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));
const be16 = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const be32 = (v: number): number[] => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const le24 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());
const box = (type: string, ...body: number[][]): number[] => {
  const flat = body.flat();
  return [...be32(flat.length + 8), ...ascii(type), ...flat];
};
const fullBox = (type: string, version: number, ...body: number[][]): number[] =>
  box(type, [version, 0, 0, 0], ...body);

/** An EBML element with a one-byte size (bodies under 127 bytes) or a two-byte one. */
const ebml = (id: number[], ...body: number[][]): number[] => {
  const flat = body.flat();
  const size =
    flat.length < 127 ? [0x80 | flat.length] : [0x40 | (flat.length >> 8), flat.length & 0xff];
  return [...id, ...size, ...flat];
};

describe("MediaDimensions.ofImage", () => {
  it("reads a PNG's IHDR", () => {
    const png = bytes(
      [0x89, ...ascii("PNG\r\n\x1a\n")],
      be32(13),
      ascii("IHDR"),
      be32(7680),
      be32(4320),
    );
    expect(MediaDimensions.ofImage(png)).toEqual({ width: 7680, height: 4320 });
  });

  it("reads a GIF's logical screen", () => {
    expect(MediaDimensions.ofImage(bytes(ascii("GIF89a"), le16(640), le16(480)))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads a JPEG's start of frame after other segments", () => {
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe0],
      be16(6),
      ascii("JFIF"),
      [0xff, 0xdb],
      be16(4),
      [0, 0],
      [0xff, 0xc2],
      be16(11),
      [8],
      be16(3000),
      be16(4000),
      [3, 0, 0],
    );
    expect(MediaDimensions.ofImage(jpeg)).toEqual({ width: 4000, height: 3000 });
  });

  it("reads WebP VP8X, VP8L and VP8 headers", () => {
    const riff = (chunk: number[]) => bytes(ascii("RIFF"), be32(0), ascii("WEBP"), chunk);
    expect(
      MediaDimensions.ofImage(
        riff([...ascii("VP8X"), ...be32(10), 0, 0, 0, 0, ...le24(8191), ...le24(4095)]),
      ),
    ).toEqual({ width: 8192, height: 4096 });
    // VP8L: 14-bit width - 1 and height - 1 after the 0x2f signature.
    const w = 999;
    const h = 499;
    const vp8l = [w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3) << 6), (h >> 2) & 0xff, (h >> 10) & 0xf];
    expect(MediaDimensions.ofImage(riff([...ascii("VP8L"), ...be32(5), 0x2f, ...vp8l]))).toEqual({
      width: 1000,
      height: 500,
    });
    expect(
      MediaDimensions.ofImage(
        riff([
          ...ascii("VP8 "),
          ...be32(10),
          0,
          0,
          0,
          0x9d,
          0x01,
          0x2a,
          ...le16(320),
          ...le16(240),
        ]),
      ),
    ).toEqual({ width: 320, height: 240 });
  });

  it("reads the largest ispe of an AVIF", () => {
    const avif = bytes(
      box("ftyp", ascii("avif"), be32(0)),
      fullBox(
        "meta",
        0,
        box(
          "iprp",
          box(
            "ipco",
            fullBox("ispe", 0, be32(160), be32(90)),
            fullBox("ispe", 0, be32(8000), be32(4500)),
          ),
        ),
      ),
    );
    expect(MediaDimensions.ofImage(avif)).toEqual({ width: 8000, height: 4500 });
  });

  it("answers undefined for what it cannot read", () => {
    expect(MediaDimensions.ofImage(bytes(ascii("not an image")))).toBeUndefined();
    expect(MediaDimensions.ofImage(bytes([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeUndefined();
  });
});

const tkhd = (width: number, height: number): number[] =>
  fullBox("tkhd", 0, new Array<number>(72).fill(0), be32(width * 65536), be32(height * 65536));
const mdhd = (timescale: number, duration: number): number[] =>
  fullBox("mdhd", 0, be32(0), be32(0), be32(timescale), be32(duration), be32(0));
const hdlr = (handler: string): number[] =>
  fullBox("hdlr", 0, be32(0), ascii(handler), new Array<number>(12).fill(0));
const stsz = (samples: number): number[] => fullBox("stsz", 0, be32(0), be32(samples));
const trak = (
  handler: string,
  width: number,
  height: number,
  timescale: number,
  duration: number,
  samples: number,
) =>
  box(
    "trak",
    tkhd(width, height),
    box("mdia", mdhd(timescale, duration), hdlr(handler), box("minf", box("stbl", stsz(samples)))),
  );

describe("MediaDimensions.ofVideo", () => {
  it("reads an MP4 video track's size and average frame rate", () => {
    const mp4 = bytes(
      box("ftyp", ascii("isom"), be32(0)),
      box(
        "moov",
        trak("soun", 0, 0, 44100, 44100, 43),
        trak("vide", 3840, 2160, 90000, 900000, 600),
      ),
    );
    expect(MediaDimensions.ofVideo(mp4)).toEqual({ width: 3840, height: 2160, frameRate: 60 });
  });

  it("leaves the frame rate unknown without samples (a fragmented MP4)", () => {
    const mp4 = bytes(
      box("ftyp", ascii("isom"), be32(0)),
      box("moov", trak("vide", 1280, 720, 1000, 0, 0)),
    );
    expect(MediaDimensions.ofVideo(mp4)).toEqual({
      width: 1280,
      height: 720,
      frameRate: undefined,
    });
  });

  it("reads a WebM track's pixel size and DefaultDuration", () => {
    const webm = bytes(
      ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], ascii("webm"))),
      ebml(
        [0x18, 0x53, 0x80, 0x67],
        ebml([0x15, 0x49, 0xa9, 0x66], ebml([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])),
        ebml(
          [0x16, 0x54, 0xae, 0x6b],
          ebml(
            [0xae],
            ebml([0x83], [1]),
            // 1 / 240 s.
            ebml([0x23, 0xe3, 0x83], be32(4_166_667)),
            ebml([0xe0], ebml([0xb0], be16(1920)), ebml([0xba], be16(1080))),
          ),
        ),
      ),
    );
    const read = MediaDimensions.ofVideo(webm);
    expect(read).toMatchObject({ width: 1920, height: 1080 });
    expect(Math.floor(read?.frameRate ?? 0)).toBe(239);
  });

  it("answers undefined for what it cannot read", () => {
    expect(MediaDimensions.ofVideo(bytes(ascii("not a video")))).toBeUndefined();
  });
});
