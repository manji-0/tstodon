import { err, ok, type Result } from "neverthrow";

/**
 * Removing the metadata a camera or editor writes into an image (EXIF with
 * its GPS position, XMP, IPTC, comments, timestamps) before the file is
 * published, as Mastodon's libvips re-encode does. The rewrite is lossless:
 * it drops metadata segments, chunks and items from the container and copies
 * the image data as it was, so it needs no decoder and runs in time linear in
 * the file size.
 *
 * What stays is what changes how the image looks: the ICC colour profile and
 * colour chunks, Adobe's colour transform marker, JFIF, and the EXIF
 * orientation. The orientation goes on as a new EXIF block holding that one
 * tag, so a rotated phone photo still displays upright everywhere it did.
 */

/** The containers the stripper rewrites. */
export type ImageContainer = "jpeg" | "png" | "webp" | "avif";

/** EXIF orientations other than 1 (as stored), the ones a viewer acts on. */
export type ExifOrientation = 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type StrippedImage = Readonly<{
  kind: "Stripped";
  format: ImageContainer;
  bytes: Uint8Array;
  /** The orientation the stripped file keeps, if any. */
  orientation: ExifOrientation | undefined;
}>;

/** What stripping found: a rewritten image, or bytes of no container it knows. */
export type ImageMetadataStrip = StrippedImage | Readonly<{ kind: "UnknownFormat" }>;

/** A file that starts like a known container but cannot be walked to its end. */
export type MalformedImage = Readonly<{
  kind: "MalformedImage";
  format: ImageContainer;
  reason: string;
}>;

export const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;

export const u16be = (bytes: Uint8Array, offset: number): number =>
  (at(bytes, offset) << 8) | at(bytes, offset + 1);

export const u32be = (bytes: Uint8Array, offset: number): number =>
  ((at(bytes, offset) << 24) |
    (at(bytes, offset + 1) << 16) |
    (at(bytes, offset + 2) << 8) |
    at(bytes, offset + 3)) >>>
  0;

const u16le = (bytes: Uint8Array, offset: number): number =>
  at(bytes, offset) | (at(bytes, offset + 1) << 8);

const u32le = (bytes: Uint8Array, offset: number): number =>
  (at(bytes, offset) |
    (at(bytes, offset + 1) << 8) |
    (at(bytes, offset + 2) << 16) |
    (at(bytes, offset + 3) << 24)) >>>
  0;

/** An unsigned big-endian integer of 0, 4 or 8 bytes (ISOBMFF field sizes). */
export const uintBe = (bytes: Uint8Array, offset: number, size: number): number =>
  size === 0
    ? 0
    : size === 4
      ? u32be(bytes, offset)
      : u32be(bytes, offset) * 0x1_0000_0000 + u32be(bytes, offset + 4);

/** A four-character code as the big-endian number its bytes spell. */
export const fourcc = (code: string): number =>
  ((code.charCodeAt(0) << 24) |
    (code.charCodeAt(1) << 16) |
    (code.charCodeAt(2) << 8) |
    code.charCodeAt(3)) >>>
  0;

/** Whether `bytes` holds the ASCII text `text` at `offset`. */
export const startsWith = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (offset + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
};

const concat = (pieces: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const piece of pieces) {
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
};

const isOrientation = (value: number): value is ExifOrientation => value >= 2 && value <= 8;

/**
 * The Orientation tag (0x0112) of IFD0 in a TIFF-structured EXIF block, which
 * may start with JPEG's `Exif\0\0` header. `undefined` when it is 1, missing,
 * or the block cannot be read.
 */
export const exifOrientation = (exif: Uint8Array): ExifOrientation | undefined => {
  const tiff = startsWith(exif, 0, "Exif\0\0") ? exif.subarray(6) : exif;
  const little = startsWith(tiff, 0, "II");
  if (!little && !startsWith(tiff, 0, "MM")) {
    return undefined;
  }
  const u16 = little ? u16le : u16be;
  const u32 = little ? u32le : u32be;
  if (tiff.length < 8 || u16(tiff, 2) !== 42) {
    return undefined;
  }
  const ifd = u32(tiff, 4);
  if (ifd + 2 > tiff.length) {
    return undefined;
  }
  const count = u16(tiff, ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) {
      return undefined;
    }
    if (u16(tiff, entry) === 0x0112) {
      // SHORT, one value, held in the first two bytes of the value field.
      const value = u16(tiff, entry + 8);
      return u16(tiff, entry + 2) === 3 && u32(tiff, entry + 4) === 1 && isOrientation(value)
        ? value
        : undefined;
    }
  }
  return undefined;
};

/** A big-endian TIFF block whose IFD0 holds only the Orientation tag. */
const orientationTiff = (orientation: ExifOrientation): Uint8Array =>
  Uint8Array.of(
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
    ...[0x00, 0x01],
    ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00],
    ...[0x00, 0x00, 0x00, 0x00],
  );

type Strip = Result<StrippedImage, MalformedImage>;

const malformed = (format: ImageContainer, reason: string): Result<never, MalformedImage> =>
  err({ kind: "MalformedImage", format, reason });

const stripped = (
  format: ImageContainer,
  bytes: Uint8Array,
  orientation: ExifOrientation | undefined,
): Strip => ok({ kind: "Stripped", format, bytes, orientation });

// --- JPEG -------------------------------------------------------------------

const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

const isStandalone = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** Whether a marker segment changes how the image decodes and so stays. */
const keepsJpegSegment = (marker: number, data: Uint8Array): boolean => {
  if (marker === APP0) {
    return startsWith(data, 0, "JFIF\0");
  }
  if (marker === APP2) {
    return startsWith(data, 0, "ICC_PROFILE\0");
  }
  if (marker === APP14) {
    return startsWith(data, 0, "Adobe");
  }
  // Every other APPn (EXIF, XMP, MPF, Photoshop/IPTC, Ducky, ...) and comments go.
  return !(marker >= APP0 && marker <= 0xef) && marker !== COM;
};

const jpegApp1 = (orientation: ExifOrientation): Uint8Array => {
  const tiff = orientationTiff(orientation);
  const length = 2 + 6 + tiff.length;
  return concat([
    Uint8Array.of(0xff, APP1, length >> 8, length & 0xff),
    Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0x00, 0x00),
    tiff,
  ]);
};

/**
 * Walk the marker segments up to the end of the image, entropy-coded scans
 * included, keeping image segments and the allow-listed APPn. Anything after
 * EOI (MPF's extra pictures, maker trailers) is dropped. A file that ends
 * inside a scan is kept as it stands, as browsers show a truncated JPEG.
 */
const stripJpeg = (bytes: Uint8Array): Strip => {
  const pieces: Uint8Array[] = [bytes.subarray(0, 2)];
  let orientation: ExifOrientation | undefined;
  let exifWritten = false;
  let sawScan = false;
  let pos = 2;
  for (;;) {
    if (pos >= bytes.length) {
      if (sawScan) {
        break;
      }
      return malformed("jpeg", "ends before the image data");
    }
    if (bytes[pos] !== 0xff) {
      return malformed("jpeg", "expected a marker");
    }
    // Fill bytes: any run of 0xFF before the marker code.
    while (bytes[pos + 1] === 0xff) {
      pos++;
    }
    if (pos + 1 >= bytes.length) {
      return malformed("jpeg", "ends inside a marker");
    }
    const marker = at(bytes, pos + 1);
    if (marker === EOI) {
      pieces.push(bytes.subarray(pos, pos + 2));
      break;
    }
    if (marker === 0x00 || marker === 0xd8) {
      return malformed("jpeg", "unexpected marker");
    }
    if (isStandalone(marker)) {
      pieces.push(bytes.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const length = u16be(bytes, pos + 2);
    const end = pos + 2 + length;
    if (pos + 4 > bytes.length || length < 2 || end > bytes.length) {
      return malformed("jpeg", "a segment runs past the end");
    }
    const data = bytes.subarray(pos + 4, end);
    if (marker === APP1 && startsWith(data, 0, "Exif\0\0")) {
      const found = exifWritten ? undefined : exifOrientation(data);
      if (found !== undefined) {
        orientation = found;
        exifWritten = true;
        pieces.push(jpegApp1(found));
      }
    } else if (keepsJpegSegment(marker, data)) {
      pieces.push(bytes.subarray(pos, end));
    }
    pos = end;
    if (marker !== SOS) {
      continue;
    }
    sawScan = true;
    // Entropy-coded data runs to the next marker other than a stuffed 0xFF00
    // or a restart marker.
    let scan = pos;
    for (;;) {
      const ff = bytes.indexOf(0xff, scan);
      if (ff === -1 || ff + 1 >= bytes.length) {
        scan = bytes.length;
        break;
      }
      const next = at(bytes, ff + 1);
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
        scan = ff + (next === 0xff ? 1 : 2);
        continue;
      }
      scan = ff;
      break;
    }
    pieces.push(bytes.subarray(pos, scan));
    pos = scan;
  }
  return stripped("jpeg", concat(pieces), orientation);
};

// --- PNG --------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const IHDR = fourcc("IHDR");
const IEND = fourcc("IEND");
const EXIF_PNG = fourcc("eXIf");

/**
 * Ancillary chunks that change how the image looks or animates. The rest of
 * the ancillary chunks go: text (`tEXt`, `zTXt`, `iTXt`), `eXIf`, `tIME`, and
 * any private chunk (Apple's `iDOT` holds offsets that dropping chunks would
 * break). Critical chunks always stay.
 */
const KEPT_PNG_CHUNKS: ReadonlySet<number> = new Set(
  [
    "tRNS",
    "cHRM",
    "gAMA",
    "iCCP",
    "sBIT",
    "sRGB",
    "cICP",
    "mDCV",
    "cLLI",
    "bKGD",
    "hIST",
    "pHYs",
    "sPLT",
    "acTL",
    "fcTL",
    "fdAT",
  ].map(fourcc),
);

let crcTable: Uint32Array | undefined;

/** CRC-32 (ISO 3309), as PNG computes it over a chunk's type and data. */
export const crc32 = (bytes: Uint8Array): number => {
  const table =
    crcTable ??
    (crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return c >>> 0;
    }));
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const be32 = (value: number): Uint8Array =>
  Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

/** A PNG chunk with its length and CRC. */
export const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typed = concat([Uint8Array.of(...Array.from(type, (c) => c.charCodeAt(0))), data]);
  return concat([be32(data.length), typed, be32(crc32(typed))]);
};

const isChunkLetter = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

const stripPng = (bytes: Uint8Array): Strip => {
  const pieces: Uint8Array[] = [bytes.subarray(0, 8)];
  let orientation: ExifOrientation | undefined;
  let pos = 8;
  let first = true;
  for (;;) {
    if (pos + 12 > bytes.length) {
      return malformed("png", "ends before IEND");
    }
    const length = u32be(bytes, pos);
    const type = u32be(bytes, pos + 4);
    const end = pos + 12 + length;
    if (length > 0x7fff_ffff || end > bytes.length) {
      return malformed("png", "a chunk runs past the end");
    }
    for (let i = 4; i < 8; i++) {
      if (!isChunkLetter(at(bytes, pos + i))) {
        return malformed("png", "invalid chunk type");
      }
    }
    if (first && type !== IHDR) {
      return malformed("png", "does not start with IHDR");
    }
    first = false;
    // Bit 5 of the first type byte clear: a critical chunk, needed to decode.
    const critical = (at(bytes, pos + 4) & 0x20) === 0;
    if (type === EXIF_PNG) {
      const found =
        orientation === undefined ? exifOrientation(bytes.subarray(pos + 8, end - 4)) : undefined;
      if (found !== undefined) {
        orientation = found;
        pieces.push(pngChunk("eXIf", orientationTiff(found)));
      }
    } else if (critical || KEPT_PNG_CHUNKS.has(type)) {
      pieces.push(bytes.subarray(pos, end));
    }
    pos = end;
    if (type === IEND) {
      break;
    }
  }
  return stripped("png", concat(pieces), orientation);
};

// --- WebP -------------------------------------------------------------------

const VP8X = fourcc("VP8X");
const VP8 = fourcc("VP8 ");
const VP8L = fourcc("VP8L");
const ANMF = fourcc("ANMF");
const EXIF_WEBP = fourcc("EXIF");

/** Chunks of an extended WebP that make up the picture; EXIF, XMP and unknown chunks go. */
const KEPT_WEBP_CHUNKS: ReadonlySet<number> = new Set(
  ["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"].map(fourcc),
);

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

const PAD = Uint8Array.of(0);

const le32 = (value: number): Uint8Array =>
  Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);

const stripWebp = (bytes: Uint8Array): Strip => {
  const fileEnd = 8 + u32le(bytes, 4);
  if (fileEnd > bytes.length) {
    return malformed("webp", "the RIFF size runs past the end");
  }
  const pieces: Uint8Array[] = [];
  let header: Uint8Array | undefined;
  let orientation: ExifOrientation | undefined;
  let sawImage = false;
  let pos = 12;
  while (pos + 8 <= fileEnd) {
    const type = u32be(bytes, pos);
    const size = u32le(bytes, pos + 4);
    const dataEnd = pos + 8 + size;
    if (dataEnd > fileEnd) {
      return malformed("webp", "a chunk runs past the end");
    }
    if (pos === 12 && type === VP8X) {
      if (size < 10) {
        return malformed("webp", "VP8X is too short");
      }
      header = bytes.slice(pos, dataEnd);
      pieces.push(header);
      if (size % 2 === 1) {
        pieces.push(PAD);
      }
    } else if (type === EXIF_WEBP) {
      const found =
        header && orientation === undefined
          ? exifOrientation(bytes.subarray(pos + 8, dataEnd))
          : undefined;
      if (found !== undefined) {
        orientation = found;
        const tiff = orientationTiff(found);
        pieces.push(Uint8Array.of(0x45, 0x58, 0x49, 0x46), le32(tiff.length), tiff);
      }
    } else if (KEPT_WEBP_CHUNKS.has(type) && type !== VP8X) {
      sawImage ||= type === VP8 || type === VP8L || type === ANMF;
      pieces.push(bytes.subarray(pos, dataEnd));
      if (size % 2 === 1) {
        pieces.push(PAD);
      }
    }
    pos = dataEnd + (size % 2);
  }
  if (!sawImage) {
    return malformed("webp", "has no image data");
  }
  if (header) {
    // The flags byte follows the chunk header: say which metadata is left.
    const flags = at(header, 8) & ~(VP8X_EXIF | VP8X_XMP);
    header[8] = orientation === undefined ? flags : flags | VP8X_EXIF;
  }
  const body = concat(pieces);
  return stripped(
    "webp",
    concat([
      Uint8Array.of(0x52, 0x49, 0x46, 0x46),
      le32(body.length + 4),
      Uint8Array.of(0x57, 0x45, 0x42, 0x50),
      body,
    ]),
    orientation,
  );
};

// --- AVIF -------------------------------------------------------------------

/** An ISOBMFF box: its type, where its payload starts, and where it ends. */
export type IsoBox = Readonly<{ type: number; body: number; end: number }>;

type Box = IsoBox;

/** The ISOBMFF box at `pos`, or `undefined` when its size does not fit within `limit`. */
const boxAt = (bytes: Uint8Array, pos: number, limit: number): Box | undefined => {
  if (pos + 8 > limit) {
    return undefined;
  }
  const size32 = u32be(bytes, pos);
  const type = u32be(bytes, pos + 4);
  const large = size32 === 1;
  if (large && pos + 16 > limit) {
    return undefined;
  }
  const size = large ? uintBe(bytes, pos + 8, 8) : size32 === 0 ? limit - pos : size32;
  const body = pos + (large ? 16 : 8);
  return size < body - pos || pos + size > limit ? undefined : { type, body, end: pos + size };
};

/** The boxes directly inside `[start, end)`; `undefined` when one does not fit. */
const childBoxes = (bytes: Uint8Array, start: number, end: number): Box[] | undefined => {
  const boxes: Box[] = [];
  let pos = start;
  while (pos < end) {
    const box = boxAt(bytes, pos, end);
    if (!box) {
      return undefined;
    }
    boxes.push(box);
    pos = box.end;
  }
  return boxes;
};

const FTYP = fourcc("ftyp");
const META = fourcc("meta");
const IINF = fourcc("iinf");
const INFE = fourcc("infe");
const ILOC = fourcc("iloc");
const IDAT = fourcc("idat");
const EXIF_ITEM = fourcc("Exif");
const MIME_ITEM = fourcc("mime");
const AVIF_BRANDS: ReadonlySet<number> = new Set([fourcc("avif"), fourcc("avis")]);

type MetadataItem = "exif" | "xmp";

/** The `iinf` items that hold EXIF or XMP, by item id. */
const metadataItems = (bytes: Uint8Array, iinf: Box): Map<number, MetadataItem> | undefined => {
  const version = at(bytes, iinf.body);
  const entries = childBoxes(bytes, iinf.body + 4 + (version === 0 ? 2 : 4), iinf.end);
  if (!entries) {
    return undefined;
  }
  const items = new Map<number, MetadataItem>();
  for (const infe of entries) {
    const infeVersion = at(bytes, infe.body);
    if (infe.type !== INFE || infeVersion < 2) {
      continue;
    }
    const idSize = infeVersion === 2 ? 2 : 4;
    const id = idSize === 2 ? u16be(bytes, infe.body + 4) : u32be(bytes, infe.body + 4);
    const typeAt = infe.body + 4 + idSize + 2;
    if (typeAt + 4 > infe.end) {
      return undefined;
    }
    const itemType = u32be(bytes, typeAt);
    if (itemType === EXIF_ITEM) {
      items.set(id, "exif");
    } else if (itemType === MIME_ITEM) {
      // The item name, a null-terminated string, comes before the content type.
      const name = bytes.subarray(0, infe.end).indexOf(0, typeAt + 4);
      if (name === -1) {
        return undefined;
      }
      if (startsWith(bytes.subarray(0, infe.end), name + 1, "application/rdf+xml\0")) {
        items.set(id, "xmp");
      }
    }
  }
  return items;
};

type Extent = Readonly<{ start: number; length: number }>;

/**
 * The byte ranges `iloc` gives each listed item, in file offsets. Items
 * stored in `idat` count from its body; an item built from other items
 * (construction method 2) holds no bytes of its own.
 */
const itemExtents = (
  bytes: Uint8Array,
  iloc: Box,
  idatBody: number | undefined,
  wanted: ReadonlyMap<number, MetadataItem>,
): Map<number, Extent[]> | undefined => {
  const version = at(bytes, iloc.body);
  if (version > 2) {
    return undefined;
  }
  let pos = iloc.body + 4;
  const sizes = u16be(bytes, pos);
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf;
  const indexSize = version === 0 ? 0 : sizes & 0xf;
  if (
    ![offsetSize, lengthSize, baseOffsetSize, indexSize].every((s) => s === 0 || s === 4 || s === 8)
  ) {
    return undefined;
  }
  pos += 2;
  const count = version < 2 ? u16be(bytes, pos) : u32be(bytes, pos);
  pos += version < 2 ? 2 : 4;
  const extents = new Map<number, Extent[]>();
  for (let i = 0; i < count; i++) {
    const idSize = version < 2 ? 2 : 4;
    const fixed = idSize + (version === 0 ? 0 : 2) + 2 + baseOffsetSize + 2;
    if (pos + fixed > iloc.end) {
      return undefined;
    }
    const id = idSize === 2 ? u16be(bytes, pos) : u32be(bytes, pos);
    pos += idSize;
    const method = version === 0 ? 0 : u16be(bytes, pos) & 0xf;
    pos += version === 0 ? 2 : 4; // construction method, data reference index
    const base = uintBe(bytes, pos, baseOffsetSize);
    pos += baseOffsetSize;
    const extentCount = u16be(bytes, pos);
    pos += 2;
    const ranges: Extent[] = [];
    for (let e = 0; e < extentCount; e++) {
      if (pos + indexSize + offsetSize + lengthSize > iloc.end) {
        return undefined;
      }
      pos += indexSize;
      const offset = uintBe(bytes, pos, offsetSize);
      pos += offsetSize;
      const length = uintBe(bytes, pos, lengthSize);
      pos += lengthSize;
      if (!wanted.has(id) || method === 2) {
        continue;
      }
      const origin = method === 1 ? idatBody : 0;
      if (origin === undefined) {
        return undefined;
      }
      const start = origin + base + offset;
      // A length of 0 means the rest of the file.
      ranges.push({ start, length: length === 0 ? bytes.length - start : length });
    }
    extents.set(id, ranges);
  }
  return extents;
};

/** An EXIF item payload with no tags: a zero TIFF-header offset, then an empty IFD0. */
const EMPTY_EXIF_ITEM = Uint8Array.of(
  ...[0, 0, 0, 0],
  ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08],
  ...[0x00, 0x00],
  ...[0x00, 0x00, 0x00, 0x00],
);

/**
 * AVIF keeps EXIF and XMP as items whose bytes `iloc` locates, usually in
 * `mdat`. Removing them would mean rewriting every offset, so their bytes are
 * overwritten in place instead: an EXIF item becomes an empty IFD (readers
 * that insist on parsing it still can), an XMP item becomes spaces. The
 * orientation of an AVIF is its `irot` / `imir` properties, which stay.
 */
const stripAvif = (bytes: Uint8Array): Strip => {
  const top = childBoxes(bytes, 0, bytes.length);
  if (!top || top[0]?.type !== FTYP) {
    return malformed("avif", "the boxes do not fit the file");
  }
  const meta = top.find((box) => box.type === META);
  if (!meta) {
    return malformed("avif", "has no meta box");
  }
  const out = bytes.slice();
  const failure = blankHeifMetadataItems(bytes, out, meta);
  return failure === undefined ? stripped("avif", out, undefined) : malformed("avif", failure);
};

/**
 * Overwrite, in `out`, the bytes of the EXIF and XMP items that a HEIF-style
 * `meta` box (a full box holding `iinf` and `iloc`) of `bytes` lists. The
 * reason when the items cannot be read, `undefined` once done. Shared by
 * AVIF and by the file-level `meta` box of an MP4.
 */
export const blankHeifMetadataItems = (
  bytes: Uint8Array,
  out: Uint8Array,
  meta: IsoBox,
): string | undefined => {
  const children = childBoxes(bytes, meta.body + 4, meta.end);
  if (!children) {
    return "the meta boxes do not fit";
  }
  const iinf = children.find((box) => box.type === IINF);
  const iloc = children.find((box) => box.type === ILOC);
  const idat = children.find((box) => box.type === IDAT);
  const items = iinf ? metadataItems(bytes, iinf) : new Map<number, MetadataItem>();
  if (!items) {
    return "unreadable item info";
  }
  if (items.size === 0) {
    return undefined;
  }
  const extents = iloc ? itemExtents(bytes, iloc, idat?.body, items) : undefined;
  if (!extents) {
    return "unreadable item locations";
  }
  for (const [id, ranges] of extents) {
    for (const range of ranges) {
      if (range.start + range.length > out.length || range.length < 0) {
        return "an item runs past the end";
      }
      out.fill(items.get(id) === "xmp" ? 0x20 : 0, range.start, range.start + range.length);
    }
    const first = ranges[0];
    if (items.get(id) === "exif" && first && first.length >= EMPTY_EXIF_ITEM.length) {
      out.set(EMPTY_EXIF_ITEM, first.start);
    }
  }
  return undefined;
};

// --- Dispatch ----------------------------------------------------------------

/** The container `bytes` starts like, from its magic numbers. */
const containerOf = (bytes: Uint8Array): ImageContainer | undefined => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return "png";
  }
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) {
    return "webp";
  }
  const ftyp = startsWith(bytes, 4, "ftyp") ? boxAt(bytes, 0, bytes.length) : undefined;
  if (ftyp && ftyp.end >= 16) {
    // The major brand, then the compatible brands after the minor version.
    if (AVIF_BRANDS.has(u32be(bytes, 8))) {
      return "avif";
    }
    for (let pos = 16; pos + 4 <= ftyp.end; pos += 4) {
      if (AVIF_BRANDS.has(u32be(bytes, pos))) {
        return "avif";
      }
    }
  }
  return undefined;
};

const STRIPPERS: Readonly<Record<ImageContainer, (bytes: Uint8Array) => Strip>> = {
  jpeg: stripJpeg,
  png: stripPng,
  webp: stripWebp,
  avif: stripAvif,
};

export const ImageMetadata = {
  /**
   * Rewrite a JPEG, PNG, WebP or AVIF without its metadata, judged by the
   * bytes, not a declared type. `UnknownFormat` for anything else (GIF,
   * video); `MalformedImage` when the container cannot be walked, so that
   * nothing is passed on unstripped.
   */
  strip: (bytes: Uint8Array): Result<ImageMetadataStrip, MalformedImage> => {
    const format = containerOf(bytes);
    return format ? STRIPPERS[format](bytes) : ok({ kind: "UnknownFormat" });
  },
} as const;
