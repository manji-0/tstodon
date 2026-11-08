import { sampleVideoFor } from "./video-fixtures";

/**
 * Real images for upload tests (generated with sharp): a 40x30 RGB PNG and an
 * 800x600 JPEG, both colour gradients, small enough to inline, an 8x6 WebP
 * and AVIF, and builders that add the metadata a camera or editor writes.
 */

const bytesOf = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

/** 40x30, within Mastodon's `small` budget, so its preview keeps the size. */
export const PNG_40X30 = bytesOf(
  [
    "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",
  ].join(""),
);

/** 800x600, whose `small` preview is 554x415. */
export const JPEG_800X600 = bytesOf(
  [
    "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",
    "BREBUUUAQURRRUUFAQFRRQRBQFFFRQURBQFFBEFEWSKNcxICgoKIgoiigCCiICoooAgoiigiCgICoooIgoCiiooKIgKCigiC",
    "iQCgoKIgoiigCCiICoucUeA7AKigoCAqKKCIKAgKigoiCgKKCIKIgKCgoiCiKKKCgoiAqKKAIKIgKigoCCiKKCIKAgKiyQVr",
    "mJQUBBRFFBEFAQFRQURBQFFFRQURAUFFBEFEUUUFBRIFEUUAQURAVFBQEFEUUEQUBAVFFBFzqK8B2QURBQFFBEFEQFBQURBR",
    "FFAEFEQFRRQBBRFFFRQUBAVFFBEFAUUVFBREBQUUEQURRRQkFEWSKNcxQKAooIgoiAoKKCIKIooqKCgICoooIgoEiiooKIgK",
    "CigiCiKKKCgoiCiKKAIKIgKigoCCiLnFHgOwKIooAgoiAqKCgIKIooIgoCAqKCiIKIooAgoiAqKKAIKIooqKCgIKIooJAoCi",
    "iooKIgoCyRRrmKRQRBQEBUUFEQUBRQRBREBQkFEQURRRQUFEQFRRQBBRFFFRQUBBRFFBEFAQFRQURBQFFFRc4K8B2RQRBRFF",
    "FBQURBRFFAEFEQFRQUBBRFFFRQUBAVFFBEFAUUVFBRIBQUUEQURAUFBREBUUUAWSoNcxQKIgKCgoiCiKKAQKIgKiigCCiKKK",
    "igoCAqKKCIKIoooKCiICoooAgoiAqKCgIKIooIgoC51B4DsCiKKKigoCCiKKCIKAgKigoiCgKKCIKIgKCigiCiSKKigoCAqK",
    "KCIKAooqKCiICgooIgoiyRRrWKAVFBRIFAUUEQURAUFFBEFEUUAQURAVFFAEFEUUVFBQEBUUUEQUBAVFBREFAUUEQURAUFzi",
    "jwXYBQUFEQFRRQBBREBUUFAQURRQRBQIBUUFEQUBRRUUFEQFBRQRBRFFFBQURAVFFAEFEQFRZIK1rEoKIgoiigCCiICooKAg",
    "oiigiCgICoooIgoCiiooKIgKCigiCiKKKCgoiCiKKAIKIgKigoC51FeC7IKAgKiigiCgICooKIgoCigkCiICgoKIgoiiigoK",
    "IgKiigCCiKKKigoCAqKKCIKAooqKCiLJFGuYkFAUUEQURAUFBREFEUUUFBREBUUUAQURRRUUFAQFRRQRBQFFFRQURBQFFBEF",
    "EQFBQURBRFzijwHYFAUUEQURAVJBQEFEUUEQUBAVFBREFAUUEQURAUFFBEFEUUUFBREBUUUAQURRRUUFAQURZIo1zEooAgoi",
    "AqKCgIKIooIgoCAqKCiIKAooqKCiICgooIgoiiigoKIgKiigCCiKKKigoCCiKKCLwBXgOyKCIKBIoqKCiIKAooIgoiAoKCiI",
    "KIooAgoiAqKCgIKIooqKCgICoooIgoCiiooKIgKCigiyVBrmJBQEBUUFEQURRQBBREBUUFAQURRRQUFEQFRRQRBQFFFRQURA",
    "UFFBEFEQFBQURBRFFAEFEXOoPAdQURRRQUFEQFRRQBBREBUUFEQUBRQRBREBQUUEQURRRQUFEQFRRQBBRFFFRQUBAVFFBEFA",
    "WSKNcxICooKAgoiigiCgICooKIgoCigiCiICgooIgoiiigoKIgKiigCCiICooKAgKiigkCgICoucUeA7IoqKCiICgooIgoiA",
    "oKCiIKIooAgoiAqKCgIKIooIgoCAqKKCIKAooqKCiICgooIgoiAoLJBWuYlBREFAUUEQURAUFBREFEUUAQURAVFFAEFEUUVF",
    "BQEBUUUEQUBRRUUFEgFRRQBBREBUUFAXOorwHZBREBUUUAQURAVFBQEBUUUEQUBAVFBREFAUUEQURAUFFBEFEUUUFBREBUUU",
    "AQURRRUUFEWSKNaxIKIooIgoCAqKCiIKAooIgoiAoKCiIKIoooKCiICoooAgokiiooKAgoiigiCgICooKIgoC5xR4LsAoKKC",
    "IKIoooKCiIKIooAgoiAqKCgIKIooIgoCAqKKCIKAooqKCiICgooIgoiiigoKIgoiyRRrWJRQRBREBQUFEQURRQBBREBUUFAQ",
    "URRRUUFAQFRRQSBQFFFRQURAUFFBEFEUUUFBREFEUUAXgCvBdkUAQURRRUUFAQURRQRBQEBUUFEQUBRQRBREBQUFEQURRQBB",
    "REBUUUAQURRRUUFAQFSRQRZKg1rFAoiAqKCgIKIooIgoiAoKCiIKIooAgokAqKCgIKIooqKCgICoooIgoCiiooKIgoCigiCi",
    "LnUHgOwKIoooKCiICoooAgoiiigoKIgoiigiCgICooKIgoCiiooKIgKCigiCiKKKEgoiAqKKAIKIskUa5igFBQURBRFFAEFE",
    "QFRQUCBRFFBEFAQFRRQRBQFFFRQURAUFFBEFEQFBQURAVFFAEFEQFRc4o8B2RRUUFAQFRRQRBQEBUUFEQUBRQRBREBQUFEQU",
    "RRQBBREBUkUAQURRRUUFAQFRRQRBQFFFRZCg1zFACKgAigiAIqACAIqAiKAIAkoCIoAgCIoIgAKgIigiAAigiAIqACKCIAio",
    "AIAi8FB4DsAIqAiKAIAioCIACoCIoIgAKgIgCKgAigiAIqACAJKAiKAIAioCIoAgCIoIgAL/2Q==",
  ].join(""),
);

/** libvips' built-in sRGB ICC profile (480 bytes), for fixtures that carry a colour profile. */
export const SRGB_ICC = bytesOf(
  [
    "AAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbW",
    "AAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAk",
    "Y3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAU",
    "clRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBC",
    "bWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd",
    "///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVog",
    "AAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb",
  ].join(""),
);

/** An 8x6 lossy WebP in the simple format (a lone `VP8 ` chunk). */
export const WEBP_8X6 = bytesOf(
  ["UklGRjAAAABXRUJQVlA4ICQAAABQAQCdASoIAAYAAsBMJaAABAAAAP7qZWz///M0f/JH/sD1UAA="].join(""),
);

/**
 * An 8x6 AVIF whose EXIF item holds a copyright (`secret-copyright`) and a GPS
 * IFD, with an XMP item (`secret-xmp`), as sharp's `withExif` / `withXmp` write them.
 */
export const AVIF_8X6_WITH_METADATA = bytesOf(
  [
    "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAAWFtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAA",
    "AAAAAEZpbG9jAAAAAERAAAMAAQAAAAABhQABAAAAAAAAACIAAgAAAAABpwABAAAAAAAAAPoAAwAAAAACoQABAAAAAAAAADoA",
    "AABiaWluZgAAAAAAAwAAABVpbmZlAgAAAAABAABhdjAxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAACppbmZlAgAAAQADAABt",
    "aW1lAGFwcGxpY2F0aW9uL3JkZit4bWwAAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRp",
    "c3BlAAAAAAAAAAgAAAAGAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAoaXJlZgAAAAAAAAAOY2Rz",
    "YwACAAEAAQAAAA5jZHNjAAMAAQABAAABXm1kYXQSAAoIOAi9aQENBpAyFBlCYwTAADQAAJBAyRxhVcsBt49iAAAABkV4aWYA",
    "AElJKgAIAAAACAASAQMAAQAAAAEAAAAaAQUAAQAAAG4AAAAbAQUAAQAAAHYAAAAoAQMAAQAAAAIAAAATAgMAAQAAAAEAAACY",
    "ggIAEQAAAH4AAABphwQAAQAAAJAAAAAliAQAAQAAAN4AAAAAAAAAOGMAAOgDAAA4YwAA6AMAAHNlY3JldC1jb3B5cmlnaHQA",
    "AAYAAJAHAAQAAAAwMjEwAZEHAAQAAAABAgMAAKAHAAQAAAAwMTAwAaADAAEAAAD//wAAAqAEAAEAAAAIAAAAA6AEAAEAAAAG",
    "AAAAAAAAAAEAAQACAAIAAABOAAAAAAAAADx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iPnNlY3JldC14bXA8",
    "L3g6eG1wbWV0YT4=",
  ].join(""),
);

// --- Builders for images that carry metadata ---------------------------------

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

const join = (...pieces: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  pieces.reduce((offset, piece) => {
    out.set(piece, offset);
    return offset + piece.length;
  }, 0);
  return out;
};

const be16 = (value: number): Uint8Array => Uint8Array.of(value >> 8, value & 0xff);
const be32 = (value: number): Uint8Array =>
  Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const le32 = (value: number): Uint8Array =>
  Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);

/** Text the metadata fixtures hide, none of which may survive stripping. */
export const SECRETS = {
  camera: "SecretCam",
  xmp: "secret-xmp",
  comment: "secret-comment",
  iptc: "secret-iptc",
  text: "secret-text",
  trailer: "secret-trailer",
} as const;

/**
 * A little-endian TIFF/EXIF block as a phone writes it: IFD0 with the camera
 * make, an optional Orientation, and a pointer to a GPS IFD holding a
 * latitude (35° 41' 2" N).
 */
export const exifWithGps = (orientation?: number): Uint8Array => {
  const le16 = (value: number): Uint8Array => Uint8Array.of(value & 0xff, value >> 8);
  const entries = orientation === undefined ? 3 : 4;
  const ifd0Size = 2 + entries * 12 + 4;
  const makeOffset = 8 + ifd0Size;
  const make = ascii(`${SECRETS.camera}\0`);
  const gpsOffset = makeOffset + make.length;
  const gpsSize = 2 + 2 * 12 + 4;
  const latitudeOffset = gpsOffset + gpsSize;
  const entry = (tag: number, type: number, count: number, value: Uint8Array): Uint8Array =>
    join(le16(tag), le16(type), le32(count), value);
  const short = (value: number): Uint8Array => join(le16(value), Uint8Array.of(0, 0));
  return join(
    ascii("II"),
    le16(42),
    le32(8),
    le16(entries),
    entry(0x010f, 2, make.length, le32(makeOffset)),
    ...(orientation === undefined ? [] : [entry(0x0112, 3, 1, short(orientation))]),
    entry(0x0131, 2, 4, ascii("App\0")),
    entry(0x8825, 4, 1, le32(gpsOffset)),
    le32(0),
    make,
    le16(2),
    entry(0x0001, 2, 2, ascii("N\0\0\0")),
    entry(0x0002, 5, 3, le32(latitudeOffset)),
    le32(0),
    ...[35, 41, 2].flatMap((value) => [le32(value), le32(1)]),
  );
};

const XMP_PACKET = ascii(
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description>${SECRETS.xmp}</rdf:Description></x:xmpmeta>`,
);

const jpegSegment = (marker: number, data: Uint8Array): Uint8Array =>
  join(Uint8Array.of(0xff, marker), be16(data.length + 2), data);

/**
 * `JPEG_800X600` with what a camera and an editor add: EXIF with GPS (and the
 * orientation, if given), XMP, Photoshop/IPTC, a comment, the sRGB ICC
 * profile, and bytes after EOI.
 */
export const jpegWithMetadata = (orientation?: number): Uint8Array =>
  join(
    Uint8Array.of(0xff, 0xd8),
    jpegSegment(0xe1, join(ascii("Exif\0\0"), exifWithGps(orientation))),
    jpegSegment(0xe1, join(ascii("http://ns.adobe.com/xap/1.0/\0"), XMP_PACKET)),
    jpegSegment(0xed, join(ascii("Photoshop 3.0\x008BIM"), ascii(SECRETS.iptc))),
    jpegSegment(0xe2, join(ascii("ICC_PROFILE\0"), Uint8Array.of(1, 1), SRGB_ICC)),
    jpegSegment(0xfe, ascii(SECRETS.comment)),
    JPEG_800X600.subarray(2),
    ascii(SECRETS.trailer),
  );

let crcTable: ReadonlyArray<number> | undefined;

const crc32 = (bytes: Uint8Array): number => {
  crcTable ??= Array.from({ length: 256 }, (_, n) =>
    Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
  );
  const table = crcTable;
  return (
    (bytes.reduce((crc, byte) => (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8), 0xffffffff) ^
      0xffffffff) >>>
    0
  );
};

export const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typed = join(ascii(type), data);
  return join(be32(data.length), typed, be32(crc32(typed)));
};

/**
 * `PNG_40X30` with text chunks (`tEXt`, `zTXt`, `iTXt`), `tIME`, an `eXIf`
 * with GPS (and the orientation, if given), and the colour chunks `sRGB` and
 * `gAMA`, which must stay.
 */
export const pngWithMetadata = (orientation?: number): Uint8Array => {
  const ihdrEnd = 8 + 12 + 13;
  return join(
    PNG_40X30.subarray(0, ihdrEnd),
    pngChunk("sRGB", Uint8Array.of(0)),
    pngChunk("gAMA", be32(45455)),
    pngChunk("tEXt", ascii(`Comment\0${SECRETS.text}`)),
    pngChunk("zTXt", join(ascii("Comment\0\0"), ascii(SECRETS.comment))),
    pngChunk("iTXt", join(ascii("XML:com.adobe.xmp\0\0\0\0\0"), XMP_PACKET)),
    pngChunk("tIME", Uint8Array.of(0x07, 0xea, 11, 8, 12, 0, 0)),
    pngChunk("eXIf", exifWithGps(orientation)),
    PNG_40X30.subarray(ihdrEnd),
    ascii(SECRETS.trailer),
  );
};

const riffChunk = (type: string, data: Uint8Array): Uint8Array =>
  join(
    ascii(type),
    le32(data.length),
    data,
    data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(),
  );

/**
 * `WEBP_8X6` in the extended format with the sRGB ICC profile, an `EXIF`
 * chunk with GPS (and the orientation, if given), an `XMP ` chunk and an
 * unknown chunk; the VP8X flags announce ICC, EXIF and XMP.
 */
export const webpWithMetadata = (orientation?: number): Uint8Array => {
  const vp8 = WEBP_8X6.subarray(12);
  const vp8x = join(Uint8Array.of(0x20 | 0x08 | 0x04, 0, 0, 0), Uint8Array.of(7, 0, 0, 5, 0, 0));
  const body = join(
    ascii("WEBP"),
    riffChunk("VP8X", vp8x),
    riffChunk("ICCP", SRGB_ICC),
    vp8,
    riffChunk("EXIF", exifWithGps(orientation)),
    riffChunk("XMP ", XMP_PACKET),
    riffChunk("ZZZZ", ascii(SECRETS.comment)),
  );
  return join(ascii("RIFF"), le32(body.length), body);
};

/** Whether `bytes` contains the ASCII text `text` anywhere. */
export const containsText = (bytes: Uint8Array, text: string): boolean => {
  const needle = ascii(text);
  for (let i = bytes.indexOf(needle[0] ?? 0); i !== -1; i = bytes.indexOf(needle[0] ?? 0, i + 1)) {
    if (needle.every((value, offset) => bytes[i + offset] === value)) {
      return true;
    }
  }
  return false;
};

/** A JPEG's marker segments before the first scan: marker code and payload. */
export const jpegSegments = (
  bytes: Uint8Array,
): ReadonlyArray<Readonly<{ marker: number; data: Uint8Array }>> => {
  const segments: Array<Readonly<{ marker: number; data: Uint8Array }>> = [];
  let pos = 2;
  while (pos + 4 <= bytes.length && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1] ?? 0;
    const length = ((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0);
    segments.push({ marker, data: bytes.subarray(pos + 4, pos + 2 + length) });
    if (marker === 0xda) {
      break;
    }
    pos += 2 + length;
  }
  return segments;
};

/** A PNG's chunk types in order, with each chunk's data. */
export const pngChunks = (
  bytes: Uint8Array,
): ReadonlyArray<Readonly<{ type: string; data: Uint8Array }>> => {
  const chunks: Array<Readonly<{ type: string; data: Uint8Array }>> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const length = view.getUint32(pos);
    chunks.push({
      type: String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)),
      data: bytes.subarray(pos + 8, pos + 8 + length),
    });
    pos += 12 + length;
  }
  return chunks;
};

/** A WebP's chunks after the RIFF header, with each chunk's data. */
export const webpChunks = (
  bytes: Uint8Array,
): ReadonlyArray<Readonly<{ type: string; data: Uint8Array }>> => {
  const chunks: Array<Readonly<{ type: string; data: Uint8Array }>> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 12; pos + 8 <= bytes.length;) {
    const size = view.getUint32(pos + 4, true);
    chunks.push({
      type: String.fromCharCode(...bytes.subarray(pos, pos + 4)),
      data: bytes.subarray(pos + 8, pos + 8 + size),
    });
    pos += 8 + size + (size % 2);
  }
  return chunks;
};

/**
 * A real file of an upload type, for tests that only need an upload to be
 * accepted: images and videos must be readable, as their metadata is
 * stripped. A GIF passes through unread, so any bytes do.
 */
export const sampleUploadFor = (type: string): Uint8Array =>
  type === "image/jpeg"
    ? JPEG_800X600
    : type === "image/png"
      ? PNG_40X30
      : type === "image/webp"
        ? WEBP_8X6
        : type === "image/avif"
          ? AVIF_8X6_WITH_METADATA
          : type.startsWith("video/")
            ? sampleVideoFor(type)
            : Uint8Array.of(1, 2, 3);
