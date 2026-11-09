import type { ImageDimensions } from "./media-image";

/**
 * Dimensions read from a media file's header, without decoding it, as
 * Mastodon reads them with FastImage (images) and ffprobe (videos) to check
 * the advertised `image_matrix_limit`, `video_matrix_limit` and
 * `video_frame_rate_limit`. `undefined` when the header does not say; the
 * caller then lets the file through, as Mastodon does when it cannot tell.
 */

/** A video track's size and, when its container says, its average frame rate. */
export type VideoDimensions = Readonly<{
  width: number;
  height: number;
  frameRate: number | undefined;
}>;

const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;
const u16be = (bytes: Uint8Array, offset: number): number =>
  (at(bytes, offset) << 8) | at(bytes, offset + 1);
const u16le = (bytes: Uint8Array, offset: number): number =>
  at(bytes, offset) | (at(bytes, offset + 1) << 8);
const u24le = (bytes: Uint8Array, offset: number): number =>
  u16le(bytes, offset) | (at(bytes, offset + 2) << 16);
const u32be = (bytes: Uint8Array, offset: number): number =>
  ((at(bytes, offset) << 24) >>> 0) +
  (at(bytes, offset + 1) << 16) +
  (at(bytes, offset + 2) << 8) +
  at(bytes, offset + 3);
const u64be = (bytes: Uint8Array, offset: number): number =>
  u32be(bytes, offset) * 2 ** 32 + u32be(bytes, offset + 4);
const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const positive = (width: number, height: number): ImageDimensions | undefined =>
  width > 0 && height > 0 ? { width, height } : undefined;

/** Start-of-frame markers: `SOF0`–`SOF15` except `DHT`, `JPG` and `DAC`. */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const jpegDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  let pos = 2;
  while (pos + 9 < bytes.length) {
    if (at(bytes, pos) !== 0xff) {
      return undefined;
    }
    const marker = at(bytes, pos + 1);
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      return undefined;
    }
    if (isStartOfFrame(marker)) {
      return positive(u16be(bytes, pos + 7), u16be(bytes, pos + 5));
    }
    pos += 2 + u16be(bytes, pos + 2);
  }
  return undefined;
};

const webpDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return positive(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
  }
  if (chunk === "VP8L") {
    const b1 = at(bytes, 22);
    const b2 = at(bytes, 23);
    const b3 = at(bytes, 24);
    return positive(
      1 + (((b1 & 0x3f) << 8) | at(bytes, 21)),
      1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    );
  }
  if (chunk === "VP8 ") {
    return positive(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  return undefined;
};

type Box = Readonly<{ type: string; body: number; end: number }>;

/** The ISO BMFF boxes between `start` and `end`; a malformed size ends the list. */
const boxes = (bytes: Uint8Array, start: number, end: number): Box[] => {
  const found: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = u32be(bytes, pos);
    const type = ascii(bytes, pos + 4, 4);
    const [header, size] =
      size32 === 1 ? [16, u64be(bytes, pos + 8)] : [8, size32 === 0 ? end - pos : size32];
    if (size < header || pos + size > end) {
      break;
    }
    found.push({ type, body: pos + header, end: pos + size });
    pos += size;
  }
  return found;
};

const child = (bytes: Uint8Array, parent: Box, type: string, skip = 0): Box | undefined =>
  boxes(bytes, parent.body + skip, parent.end).find((box) => box.type === type);

/** The largest `ispe` (image spatial extent) property: the primary image's size. */
const avifDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  const meta = boxes(bytes, 0, bytes.length).find((box) => box.type === "meta");
  const iprp = meta ? child(bytes, meta, "iprp", 4) : undefined;
  const ipco = iprp ? child(bytes, iprp, "ipco") : undefined;
  if (!ipco) {
    return undefined;
  }
  let largest: ImageDimensions | undefined;
  for (const box of boxes(bytes, ipco.body, ipco.end)) {
    if (box.type === "ispe" && box.body + 12 <= box.end) {
      const width = u32be(bytes, box.body + 4);
      const height = u32be(bytes, box.body + 8);
      if (!largest || width * height > largest.width * largest.height) {
        largest = positive(width, height) ?? largest;
      }
    }
  }
  return largest;
};

/** An MP4 / QuickTime video track: `tkhd`'s display size, `stsz` over `mdhd`. */
const mp4TrackDimensions = (bytes: Uint8Array, trak: Box): VideoDimensions | undefined => {
  const mdia = child(bytes, trak, "mdia");
  const hdlr = mdia ? child(bytes, mdia, "hdlr") : undefined;
  if (!mdia || !hdlr || ascii(bytes, hdlr.body + 8, 4) !== "vide") {
    return undefined;
  }
  const tkhd = child(bytes, trak, "tkhd");
  if (!tkhd || tkhd.end - tkhd.body < 84) {
    return undefined;
  }
  // The display width and height close the box, as 16.16 fixed point.
  const size = positive(
    Math.round(u32be(bytes, tkhd.end - 8) / 65536),
    Math.round(u32be(bytes, tkhd.end - 4) / 65536),
  );
  if (!size) {
    return undefined;
  }
  const mdhd = child(bytes, mdia, "mdhd");
  const minf = child(bytes, mdia, "minf");
  const stbl = minf ? child(bytes, minf, "stbl") : undefined;
  const stsz = stbl ? child(bytes, stbl, "stsz") : undefined;
  let frameRate: number | undefined;
  if (mdhd && stsz) {
    const version1 = at(bytes, mdhd.body) === 1;
    const timescale = u32be(bytes, mdhd.body + (version1 ? 20 : 12));
    const duration = version1 ? u64be(bytes, mdhd.body + 24) : u32be(bytes, mdhd.body + 16);
    const samples = u32be(bytes, stsz.body + 8);
    frameRate =
      timescale > 0 && duration > 0 && samples > 0 ? (samples * timescale) / duration : undefined;
  }
  return { ...size, frameRate };
};

const mp4Dimensions = (bytes: Uint8Array): VideoDimensions | undefined => {
  const moov = boxes(bytes, 0, bytes.length).find((box) => box.type === "moov");
  if (!moov) {
    return undefined;
  }
  return largestVideo(
    boxes(bytes, moov.body, moov.end)
      .filter((box) => box.type === "trak")
      .map((trak) => mp4TrackDimensions(bytes, trak)),
  );
};

const largestVideo = (
  tracks: ReadonlyArray<VideoDimensions | undefined>,
): VideoDimensions | undefined =>
  tracks.reduce<VideoDimensions | undefined>(
    (largest, track) =>
      track && (!largest || track.width * track.height > largest.width * largest.height)
        ? track
        : largest,
    undefined,
  );

type Vint = Readonly<{ value: number; length: number; unknown: boolean }>;

/** An EBML variable-size integer; `raw` keeps the length marker (element ids). */
const vint = (bytes: Uint8Array, pos: number, raw: boolean): Vint | undefined => {
  const first = at(bytes, pos);
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) {
    length += 1;
  }
  if (length > 8 || pos + length > bytes.length) {
    return undefined;
  }
  let value = raw ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    const byte = at(bytes, pos + index);
    value = value * 256 + byte;
    allOnes = allOnes && byte === 0xff;
  }
  return { value, length, unknown: !raw && allOnes };
};

type Element = Readonly<{ id: number; body: number; end: number }>;

/** The EBML elements between `start` and `end`; an element of unknown size runs to `end`. */
const elements = (bytes: Uint8Array, start: number, end: number): Element[] => {
  const found: Element[] = [];
  let pos = start;
  while (pos < end) {
    const id = vint(bytes, pos, true);
    const size = id ? vint(bytes, pos + id.length, false) : undefined;
    if (!id || !size) {
      break;
    }
    const body = pos + id.length + size.length;
    const elementEnd = size.unknown ? end : Math.min(body + size.value, end);
    found.push({ id: id.value, body, end: elementEnd });
    if (size.unknown) {
      break;
    }
    pos = elementEnd;
  }
  return found;
};

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const DEFAULT_DURATION = 0x23e383;

const ebmlUint = (bytes: Uint8Array, element: Element | undefined): number | undefined => {
  if (!element || element.end - element.body > 8 || element.end <= element.body) {
    return undefined;
  }
  let value = 0;
  for (let pos = element.body; pos < element.end; pos += 1) {
    value = value * 256 + at(bytes, pos);
  }
  return value;
};

/** A WebM / Matroska video track: `PixelWidth` × `PixelHeight`, 1 s over `DefaultDuration`. */
const webmDimensions = (bytes: Uint8Array): VideoDimensions | undefined => {
  const segment = elements(bytes, 0, bytes.length).find((element) => element.id === SEGMENT);
  const tracks = segment
    ? elements(bytes, segment.body, segment.end).find((element) => element.id === TRACKS)
    : undefined;
  if (!tracks) {
    return undefined;
  }
  return largestVideo(
    elements(bytes, tracks.body, tracks.end)
      .filter((element) => element.id === TRACK_ENTRY)
      .map((entry) => {
        const fields = elements(bytes, entry.body, entry.end);
        const video = fields.find((element) => element.id === VIDEO);
        if (!video) {
          return undefined;
        }
        const videoFields = elements(bytes, video.body, video.end);
        const size = positive(
          ebmlUint(
            bytes,
            videoFields.find((element) => element.id === PIXEL_WIDTH),
          ) ?? 0,
          ebmlUint(
            bytes,
            videoFields.find((element) => element.id === PIXEL_HEIGHT),
          ) ?? 0,
        );
        const frameNanoseconds = ebmlUint(
          bytes,
          fields.find((element) => element.id === DEFAULT_DURATION),
        );
        return size
          ? {
              ...size,
              frameRate:
                frameNanoseconds && frameNanoseconds > 0 ? 1e9 / frameNanoseconds : undefined,
            }
          : undefined;
      }),
  );
};

export const MediaDimensions = {
  /** A JPEG's, PNG's, GIF's, WebP's or AVIF's size, from its header. */
  ofImage: (bytes: Uint8Array): ImageDimensions | undefined => {
    if (at(bytes, 0) === 0xff && at(bytes, 1) === 0xd8) {
      return jpegDimensions(bytes);
    }
    if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n" && ascii(bytes, 12, 4) === "IHDR") {
      return positive(u32be(bytes, 16), u32be(bytes, 20));
    }
    if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
      return positive(u16le(bytes, 6), u16le(bytes, 8));
    }
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
      return webpDimensions(bytes);
    }
    if (ascii(bytes, 4, 4) === "ftyp") {
      return avifDimensions(bytes);
    }
    return undefined;
  },

  /** An MP4's or WebM's largest video track, from its container. */
  ofVideo: (bytes: Uint8Array): VideoDimensions | undefined => {
    if (ascii(bytes, 4, 4) === "ftyp" || ascii(bytes, 4, 4) === "moov") {
      return mp4Dimensions(bytes);
    }
    if (u32be(bytes, 0) === 0x1a45dfa3) {
      return webmDimensions(bytes);
    }
    return undefined;
  },
} as const;
