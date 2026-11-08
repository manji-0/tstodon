import { err, ok, type Result } from "neverthrow";
import { at, blankHeifMetadataItems, fourcc, u16be, u32be, uintBe } from "./image-metadata";

/**
 * Removing the metadata a phone or camera writes into a video (its GPS
 * position, device make and model, owner, creation dates, editing software
 * notes, XMP) before the file is published. Mastodon gets the same by
 * re-encoding with ffmpeg and `-map_metadata -1`; a Worker has no ffmpeg, so
 * the container is rewritten losslessly instead.
 *
 * Nothing moves: a metadata box or element is overwritten where it is with
 * filler of the same length (an MP4 `free` box, a Matroska `Void` element)
 * whose payload is zeroed. The chunk offsets (`stco` / `co64`), fragment
 * offsets, `iloc` extents, SeekHead and Cues positions that point past it stay
 * valid, the file keeps its length, and the walk is one linear pass over the
 * box or element headers of a single copy of the input; sample data and
 * clusters are never read.
 */

/**
 * The containers the stripper rewrites: ISO BMFF (MP4, QuickTime MOV, M4V,
 * 3GP) and EBML (WebM, Matroska).
 */
export type VideoContainer = "mp4" | "webm";

export type StrippedVideo = Readonly<{
  kind: "Stripped";
  format: VideoContainer;
  bytes: Uint8Array;
}>;

/** What stripping found: a rewritten video, or bytes of no container it knows. */
export type VideoMetadataStrip = StrippedVideo | Readonly<{ kind: "UnknownFormat" }>;

/** A file that starts like a known container but cannot be walked to its end. */
export type MalformedVideo = Readonly<{
  kind: "MalformedVideo";
  format: VideoContainer;
  reason: string;
}>;

type Strip = Result<StrippedVideo, MalformedVideo>;

/** Thrown inside a walk, caught by `strip`, so a deep walk can give up at once. */
class Malformed extends Error {}

const fail = (reason: string): never => {
  throw new Malformed(reason);
};

// --- MP4 / QuickTime (ISO BMFF) -----------------------------------------------

type Mp4Box = Readonly<{
  type: number;
  start: number;
  body: number;
  end: number;
  /** Where the box says it ends, past `end` for an `mdat` cut short. */
  declaredEnd: number;
}>;

const box = (code: string): number => fourcc(code);

const FTYP = box("ftyp");
const MOOV = box("moov");
const MDAT = box("mdat");
const MOOF = box("moof");
const TRAK = box("trak");
const TRAF = box("traf");
const MDIA = box("mdia");
const MINF = box("minf");
const STBL = box("stbl");
const MVEX = box("mvex");
const TREX = box("trex");
const TKHD = box("tkhd");
const MVHD = box("mvhd");
const MDHD = box("mdhd");
const HDLR = box("hdlr");
const TFHD = box("tfhd");
const TRUN = box("trun");
const STSC = box("stsc");
const STSZ = box("stsz");
const STZ2 = box("stz2");
const STCO = box("stco");
const CO64 = box("co64");
const META = box("meta");
const UUID = box("uuid");
const PICT = box("pict");

/** Top-level types a QuickTime file without `ftyp` may start with. */
const MP4_FIRST_BOXES: ReadonlySet<number> = new Set(
  ["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"].map(box),
);

/**
 * Boxes that hold only metadata, wherever the walk meets them: user data
 * (`©xyz` location, `©mak` / `©mod` device, `©day`, GoPro's `GPMF`, `XMP_`,
 * iTunes `meta` / `ilst`), QuickTime and ISO `meta` (the
 * `com.apple.quicktime.location.ISO6709`, make, model and creation date
 * keys), the additional metadata container, Adobe's `XMP_`, and the
 * producer reference time (a wall-clock timestamp).
 */
const METADATA_BOXES: ReadonlySet<number> = new Set(
  ["udta", "meta", "meco", "XMP_", "prft"].map(box),
);

/** Containers walked for metadata below `moov` and `traf`. */
const WALKED_CONTAINERS: ReadonlySet<number> = new Set([MDIA, MINF]);

/** Boxes whose creation and modification times are zeroed. */
const TIMESTAMPED: ReadonlySet<number> = new Set([MVHD, TKHD, MDHD]);

/**
 * Track handlers whose samples are timed metadata, not picture or sound:
 * ISO timed metadata (GoPro's `gpmd` GPS and sensor track, DJI's `djmd`,
 * Apple's `mebx`) and Google's camera motion metadata (`camm`, which carries
 * GPS fixes).
 */
const METADATA_TRACK_HANDLERS: ReadonlySet<number> = new Set([box("meta"), box("camm")]);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * `uuid` boxes known to hold metadata wherever they are: XMP, Canon's
 * CMT (EXIF with GPS), Sony's user metadata. Other `uuid` boxes below the top
 * level (PIFF encryption and timing boxes, a `pssh`) can be needed to play.
 */
const METADATA_UUIDS: ReadonlySet<string> = new Set([
  "be7acfcb97a942e89c71999491e3afac",
  "85c0b687820f11e08111f4ce462b6a48",
  "55534d5421d24fcebb88695cfac9c740",
]);

/** Containers nest a handful of levels; anything deeper is not a video. */
const MAX_MP4_DEPTH = 8;

/**
 * The boxes directly inside `[start, end)`. At the top level the last box
 * may be an `mdat` cut short by the end of the file (an interrupted upload or
 * recording), which a browser still plays as far as it goes; it then ends at
 * the end of the file.
 */
const mp4Boxes = (bytes: Uint8Array, start: number, end: number, top: boolean): Mp4Box[] => {
  const boxes: Mp4Box[] = [];
  let pos = start;
  while (pos < end) {
    if (pos + 8 > end) {
      return fail("a box header runs past the end");
    }
    const size32 = u32be(bytes, pos);
    const type = u32be(bytes, pos + 4);
    const large = size32 === 1;
    if (large && pos + 16 > end) {
      return fail("a box header runs past the end");
    }
    const body = pos + (large ? 16 : 8);
    const size = large ? uintBe(bytes, pos + 8, 8) : size32 === 0 ? end - pos : size32;
    if (size < body - pos) {
      return fail("a box is smaller than its header");
    }
    if (pos + size > end) {
      if (!(top && type === MDAT)) {
        return fail("a box runs past the end");
      }
      boxes.push({ type, start: pos, body, end, declaredEnd: pos + size });
      break;
    }
    boxes.push({ type, start: pos, body, end: pos + size, declaredEnd: pos + size });
    pos += size;
  }
  return boxes;
};

const childrenOf = (bytes: Uint8Array, parent: Mp4Box): Mp4Box[] =>
  mp4Boxes(bytes, parent.body, parent.end, false);

const firstChild = (boxes: ReadonlyArray<Mp4Box>, type: number): Mp4Box | undefined =>
  boxes.find((child) => child.type === type);

/** Turn a box into a `free` box of the same size with a zeroed payload. */
const neutralize = (out: Uint8Array, target: Mp4Box): void => {
  out.set([0x66, 0x72, 0x65, 0x65], target.start + 4);
  out.fill(0, target.body, target.end);
};

const isMetadataUuid = (bytes: Uint8Array, target: Mp4Box): boolean =>
  target.body + 16 <= target.end &&
  METADATA_UUIDS.has(hex(bytes.subarray(target.body, target.body + 16)));

/** Whether a box below the top level holds only metadata. */
const isMetadataBox = (bytes: Uint8Array, target: Mp4Box): boolean =>
  METADATA_BOXES.has(target.type) ||
  // `©xyz`, `©day`, `©mak` and the other QuickTime text atoms.
  at(bytes, target.start + 4) === 0xa9 ||
  (target.type === UUID && isMetadataUuid(bytes, target));

/** The version byte of a full box, after checking its fields fit. */
const fullBoxVersion = (
  bytes: Uint8Array,
  target: Mp4Box,
  fields: (version: number) => number,
): number => {
  const version = at(bytes, target.body);
  if (target.body + 4 + fields(version) > target.end) {
    fail("a header box is too short");
  }
  return version;
};

/**
 * Zero the creation and modification times of `mvhd`, `tkhd` or `mdhd`
 * (seconds since 1904, 32 bits in version 0, 64 in version 1), as ffmpeg
 * writes them when the source's `creation_time` is dropped.
 */
const zeroTimes = (bytes: Uint8Array, out: Uint8Array, target: Mp4Box): void => {
  const version = fullBoxVersion(bytes, target, (v) => (v === 1 ? 16 : 8));
  out.fill(0, target.body + 4, target.body + 4 + (version === 1 ? 16 : 8));
};

/** The handler type of a `meta` box, QuickTime style (no version) or ISO style. */
const metaHandler = (bytes: Uint8Array, meta: Mp4Box): number | undefined => {
  for (const offset of [4, 0]) {
    const at4 = meta.body + offset;
    if (at4 + 20 <= meta.end && u32be(bytes, at4 + 4) === HDLR) {
      return u32be(bytes, at4 + 16);
    }
  }
  return undefined;
};

type Mp4Walk = Readonly<{
  bytes: Uint8Array;
  out: Uint8Array;
  /**
   * Top-level `mdat` payloads, in file order, that metadata samples must lie
   * in; each ends where its header says, which may be past the file's end.
   */
  mdats: ReadonlyArray<Readonly<{ start: number; end: number }>>;
  /** Track ids of the timed metadata tracks taken out of `moov`. */
  metadataTracks: Set<number>;
  /** `trex` default sample sizes by track id, for fragments. */
  defaultSampleSizes: Map<number, number>;
}>;

/** Zero `[start, start + length)`, which must lie within one `mdat`. */
const zeroSamples = (walk: Mp4Walk, start: number, length: number): void => {
  if (length === 0) {
    return;
  }
  const end = start + length;
  // The last mdat starting at or before `start` (they are in file order).
  let low = 0;
  let high = walk.mdats.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((walk.mdats[middle]?.start ?? 0) <= start) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const mdat = walk.mdats[low];
  if (!mdat || start < mdat.start || end > mdat.end) {
    fail("a metadata sample lies outside mdat");
  }
  // Samples of an mdat cut short are zeroed as far as the file goes.
  walk.out.fill(0, start, Math.min(end, walk.out.length));
};

/**
 * Zero the samples of a track from its sample table: one range per chunk,
 * as the samples of a chunk are contiguous. Time is linear in the number of
 * chunks and samples listed.
 */
const zeroTrackSamples = (walk: Mp4Walk, stbl: Mp4Box): void => {
  const { bytes } = walk;
  const tables = childrenOf(bytes, stbl);
  const stsc = firstChild(tables, STSC);
  const sizes = firstChild(tables, STSZ) ?? firstChild(tables, STZ2);
  const chunks = firstChild(tables, STCO) ?? firstChild(tables, CO64);
  if (!stsc || !sizes || !chunks) {
    if (stsc || sizes || chunks) {
      fail("an incomplete sample table");
    }
    return;
  }
  const offsetSize = chunks.type === CO64 ? 8 : 4;
  const chunkCount = u32be(bytes, chunks.body + 4);
  if (chunks.body + 8 + chunkCount * offsetSize > chunks.end) {
    fail("a chunk table runs past its box");
  }
  const stscCount = u32be(bytes, stsc.body + 4);
  if (stsc.body + 8 + stscCount * 12 > stsc.end) {
    fail("a sample-to-chunk table runs past its box");
  }
  const compact = sizes.type === STZ2;
  const fieldBits = compact ? at(bytes, sizes.body + 7) : 32;
  const constantSize = compact ? 0 : u32be(bytes, sizes.body + 4);
  const sampleCount = u32be(bytes, sizes.body + 8);
  if (compact && fieldBits !== 4 && fieldBits !== 8 && fieldBits !== 16) {
    fail("an unknown compact sample size");
  }
  if (
    sizes.body + 12 > sizes.end ||
    (constantSize === 0 && sizes.body + 12 + Math.ceil((sampleCount * fieldBits) / 8) > sizes.end)
  ) {
    fail("a sample size table runs past its box");
  }
  const sampleSize = (index: number): number => {
    if (constantSize !== 0) {
      return constantSize;
    }
    const table = sizes.body + 12;
    if (fieldBits === 32) {
      return u32be(bytes, table + index * 4);
    }
    if (fieldBits === 16) {
      return u16be(bytes, table + index * 2);
    }
    if (fieldBits === 8) {
      return at(bytes, table + index);
    }
    const byte = at(bytes, table + (index >> 1));
    return index % 2 === 0 ? byte >> 4 : byte & 0xf;
  };
  let entry = 0;
  let sample = 0;
  for (let chunk = 1; chunk <= chunkCount && sample < sampleCount; chunk++) {
    while (entry + 1 < stscCount && u32be(bytes, stsc.body + 8 + (entry + 1) * 12) <= chunk) {
      entry++;
    }
    const entryAt = stsc.body + 8 + entry * 12;
    const perChunk =
      stscCount === 0 || u32be(bytes, entryAt) > chunk ? 0 : u32be(bytes, entryAt + 4);
    const inChunk = Math.min(perChunk, sampleCount - sample);
    let length = 0;
    if (constantSize !== 0) {
      length = inChunk * constantSize;
    } else {
      for (let i = 0; i < inChunk; i++) {
        length += sampleSize(sample + i);
      }
    }
    sample += inChunk;
    zeroSamples(
      walk,
      uintBe(bytes, chunks.body + 8 + (chunk - 1) * offsetSize, offsetSize),
      length,
    );
  }
};

/** Walk a container below `moov` or `traf`, neutralizing metadata. */
const walkMp4Container = (walk: Mp4Walk, container: Mp4Box, depth: number): void => {
  if (depth > MAX_MP4_DEPTH) {
    fail("boxes nest too deep");
  }
  for (const child of childrenOf(walk.bytes, container)) {
    if (isMetadataBox(walk.bytes, child)) {
      neutralize(walk.out, child);
    } else if (TIMESTAMPED.has(child.type)) {
      zeroTimes(walk.bytes, walk.out, child);
    } else if (WALKED_CONTAINERS.has(child.type)) {
      walkMp4Container(walk, child, depth + 1);
    }
  }
};

const trackId = (bytes: Uint8Array, tkhd: Mp4Box): number => {
  const version = fullBoxVersion(bytes, tkhd, (v) => (v === 1 ? 20 : 12));
  return u32be(bytes, tkhd.body + (version === 1 ? 20 : 12));
};

/**
 * A track: a timed metadata track is taken out whole (its `trak` becomes
 * `free`) and its samples in `mdat` are zeroed; any other track keeps
 * everything but its user data, `meta` and times.
 */
const walkTrack = (walk: Mp4Walk, trak: Mp4Box, depth: number): void => {
  const { bytes } = walk;
  const children = childrenOf(bytes, trak);
  const tkhd = firstChild(children, TKHD);
  const mdia = firstChild(children, MDIA);
  const mdiaChildren = mdia ? childrenOf(bytes, mdia) : [];
  const hdlr = firstChild(mdiaChildren, HDLR);
  const handler = hdlr && hdlr.body + 12 <= hdlr.end ? u32be(bytes, hdlr.body + 8) : undefined;
  if (handler !== undefined && METADATA_TRACK_HANDLERS.has(handler)) {
    if (tkhd) {
      walk.metadataTracks.add(trackId(bytes, tkhd));
    }
    const minf = firstChild(mdiaChildren, MINF);
    const stbl = minf ? firstChild(childrenOf(bytes, minf), STBL) : undefined;
    if (stbl) {
      zeroTrackSamples(walk, stbl);
    }
    neutralize(walk.out, trak);
    return;
  }
  walkMp4Container(walk, trak, depth + 1);
};

const walkMoov = (walk: Mp4Walk, moov: Mp4Box): void => {
  const { bytes } = walk;
  const children = childrenOf(bytes, moov);
  for (const mvex of children.filter((child) => child.type === MVEX)) {
    for (const trex of childrenOf(bytes, mvex).filter((child) => child.type === TREX)) {
      if (trex.body + 24 > trex.end) {
        fail("trex is too short");
      }
      walk.defaultSampleSizes.set(u32be(bytes, trex.body + 4), u32be(bytes, trex.body + 16));
    }
  }
  for (const child of children) {
    if (child.type === TRAK) {
      walkTrack(walk, child, 1);
    } else if (isMetadataBox(bytes, child)) {
      neutralize(walk.out, child);
    } else if (TIMESTAMPED.has(child.type)) {
      zeroTimes(bytes, walk.out, child);
    }
  }
};

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TFHD_DEFAULT_SIZE = 0x10;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_SAMPLE_FIELDS = [0x100, 0x200, 0x400, 0x800] as const;
const TRUN_SAMPLE_SIZE = 0x200;

const flagsOf = (bytes: Uint8Array, target: Mp4Box): number =>
  (at(bytes, target.body + 1) << 16) | u16be(bytes, target.body + 2);

/**
 * Where a track fragment's data ends, after zeroing it when the track is a
 * timed metadata track. `base` is where its data counts from when `tfhd`
 * gives no base: the `moof` for the first fragment, the end of the previous
 * fragment's data after that (ISO/IEC 14496-12, 8.8.7).
 */
const fragmentData = (walk: Mp4Walk, moof: Mp4Box, traf: Mp4Box, implicitBase: number): number => {
  const { bytes } = walk;
  const children = childrenOf(bytes, traf);
  const tfhd = firstChild(children, TFHD);
  if (!tfhd || tfhd.body + 8 > tfhd.end) {
    return fail("a track fragment has no tfhd");
  }
  const flags = flagsOf(bytes, tfhd);
  const track = u32be(bytes, tfhd.body + 4);
  let field = tfhd.body + 8;
  const read = (size: number): number => {
    if (field + size > tfhd.end) {
      fail("tfhd is too short");
    }
    const value = uintBe(bytes, field, size);
    field += size;
    return value;
  };
  const base =
    flags & TFHD_BASE_DATA_OFFSET
      ? read(8)
      : flags & TFHD_DEFAULT_BASE_IS_MOOF
        ? moof.start
        : implicitBase;
  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) {
    read(4);
  }
  if (flags & TFHD_DEFAULT_DURATION) {
    read(4);
  }
  const defaultSize = flags & TFHD_DEFAULT_SIZE ? read(4) : walk.defaultSampleSizes.get(track);
  const metadata = walk.metadataTracks.has(track);
  let cursor = base;
  for (const trun of children.filter((child) => child.type === TRUN)) {
    const runFlags = flagsOf(bytes, trun);
    const count = u32be(bytes, trun.body + 4);
    let pos = trun.body + 8;
    let start = cursor;
    if (runFlags & TRUN_DATA_OFFSET) {
      // A signed offset from the base.
      start = base + (u32be(bytes, pos) | 0);
      pos += 4;
    }
    if (runFlags & TRUN_FIRST_SAMPLE_FLAGS) {
      pos += 4;
    }
    const fields = TRUN_SAMPLE_FIELDS.filter((bit) => runFlags & bit);
    const stride = fields.length * 4;
    if (pos > trun.end || pos + count * stride > trun.end) {
      fail("a track run runs past its box");
    }
    let length = 0;
    if (runFlags & TRUN_SAMPLE_SIZE) {
      const sizeAt = fields.indexOf(TRUN_SAMPLE_SIZE) * 4;
      for (let i = 0; i < count; i++) {
        length += u32be(bytes, pos + i * stride + sizeAt);
      }
    } else if (count > 0) {
      if (defaultSize === undefined) {
        fail("a track run has no sample size");
      }
      length = count * (defaultSize ?? 0);
    }
    if (start < 0) {
      fail("a track run starts before the file");
    }
    if (metadata) {
      zeroSamples(walk, start, length);
    }
    cursor = start + length;
  }
  return cursor;
};

/**
 * A movie fragment: metadata boxes go, the fragments of timed metadata
 * tracks become `free` and their samples are zeroed. Sample positions are
 * only worked out when there is such a track.
 */
const walkMoof = (walk: Mp4Walk, moof: Mp4Box): void => {
  const { bytes } = walk;
  let implicitBase = moof.start;
  for (const child of childrenOf(bytes, moof)) {
    if (child.type === TRAF) {
      if (walk.metadataTracks.size > 0) {
        implicitBase = fragmentData(walk, moof, child, implicitBase);
        const tfhd = firstChild(childrenOf(bytes, child), TFHD);
        if (tfhd && walk.metadataTracks.has(u32be(bytes, tfhd.body + 4))) {
          neutralize(walk.out, child);
          continue;
        }
      }
      walkMp4Container(walk, child, 2);
    } else if (isMetadataBox(bytes, child)) {
      neutralize(walk.out, child);
    }
  }
};

const stripMp4 = (bytes: Uint8Array): Strip => {
  const top = mp4Boxes(bytes, 0, bytes.length, true);
  const moovs = top.filter((child) => child.type === MOOV);
  if (moovs.length === 0) {
    return err({ kind: "MalformedVideo", format: "mp4", reason: "has no movie box" });
  }
  const walk: Mp4Walk = {
    bytes,
    out: bytes.slice(),
    mdats: top
      .filter((child) => child.type === MDAT)
      .map((mdat) => ({ start: mdat.body, end: mdat.declaredEnd })),
    metadataTracks: new Set(),
    defaultSampleSizes: new Map(),
  };
  for (const moov of moovs) {
    walkMoov(walk, moov);
  }
  for (const child of top) {
    if (child.type === MOOF) {
      walkMoof(walk, child);
    } else if (child.type === META && metaHandler(bytes, child) === PICT) {
      // A HEIF-style item store: its EXIF and XMP items are blanked in place.
      const failure = blankHeifMetadataItems(bytes, walk.out, child);
      if (failure !== undefined) {
        fail(failure);
      }
    } else if (child.type === UUID || (child.type !== FTYP && isMetadataBox(bytes, child))) {
      // No top-level `uuid` box is needed to play: XMP, Sony's profile and
      // user metadata, a camera's own blocks.
      neutralize(walk.out, child);
    }
  }
  return ok({ kind: "Stripped", format: "mp4", bytes: walk.out });
};

// --- WebM / Matroska (EBML) -----------------------------------------------------

const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NAME = 0x536e;
const CLUSTER = 0x1f43b675;
const CUES = 0x1c53bb6b;
const CHAPTERS = 0x1043a770;
const TAGS = 0x1254c367;
const ATTACHMENTS = 0x1941a469;
const VOID = 0xec;
const CRC32 = 0xbf;

/**
 * Segment children that are only metadata: tags (title, artist, date,
 * location, encoder settings) and attachments (cover art, which can carry
 * its own EXIF, and fonts).
 */
const METADATA_ELEMENTS: ReadonlySet<number> = new Set([TAGS, ATTACHMENTS]);

/**
 * Segment information that describes the file rather than how to play it:
 * the title, the date it was made, its file names and the identifiers that
 * link it to sibling files. TimestampScale, Duration, ChapterTranslate,
 * MuxingApp and WritingApp (mandatory, and naming software, not a person or
 * place) stay.
 */
const INFO_METADATA: ReadonlySet<number> = new Set([
  0x7ba9, // Title
  0x4461, // DateUTC
  0x7384, // SegmentFilename
  0x3c83ab, // PrevFilename
  0x3e83bb, // NextFilename
  0x73a4, // SegmentUUID
  0x3cb923, // PrevUUID
  0x3eb923, // NextUUID
  0x4444, // SegmentFamily
]);

/** The level-1 elements, which end a Cluster of unknown size. */
const SEGMENT_CHILDREN: ReadonlySet<number> = new Set([
  SEEK_HEAD,
  INFO,
  TRACKS,
  CLUSTER,
  CUES,
  CHAPTERS,
  TAGS,
  ATTACHMENTS,
  EBML,
  SEGMENT,
]);

type EbmlElement = Readonly<{
  id: number;
  start: number;
  body: number;
  /** The end of the element; `undefined` for an unknown size. */
  end: number | undefined;
}>;

/** The length of an EBML variable-size integer from its first byte, 0 when invalid. */
const vintLength = (first: number): number => {
  for (let length = 1; length <= 8; length++) {
    if (first & (0x100 >> length)) {
      return length;
    }
  }
  return 0;
};

/**
 * The element header at `pos`: `"cut"` when the header itself runs past
 * `limit`. A size whose value bits are all ones is unknown.
 */
const ebmlElementAt = (bytes: Uint8Array, pos: number, limit: number): EbmlElement | "cut" => {
  if (pos >= limit) {
    return "cut";
  }
  const idLength = vintLength(at(bytes, pos));
  if (idLength === 0 || idLength > 4) {
    return fail("an invalid element id");
  }
  if (pos + idLength >= limit) {
    return "cut";
  }
  let id = 0;
  for (let i = 0; i < idLength; i++) {
    id = id * 256 + at(bytes, pos + i);
  }
  const sizeAt = pos + idLength;
  const sizeLength = vintLength(at(bytes, sizeAt));
  if (sizeLength === 0) {
    return fail("an invalid element size");
  }
  if (sizeAt + sizeLength > limit) {
    return "cut";
  }
  let size = at(bytes, sizeAt) & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = at(bytes, sizeAt + i);
    allOnes &&= byte === 0xff;
    size = size * 256 + byte;
  }
  const body = sizeAt + sizeLength;
  return { id, start: pos, body, end: allOnes ? undefined : body + size };
};

/** The children of a master element of known size, which must fit in it. */
const ebmlChildren = (bytes: Uint8Array, parent: EbmlElement): EbmlElement[] => {
  const end = parent.end ?? fail("an element of unknown size");
  const children: EbmlElement[] = [];
  let pos = parent.body;
  while (pos < end) {
    const child = ebmlElementAt(bytes, pos, end);
    if (child === "cut" || child.end === undefined || child.end > end) {
      return fail("an element runs past its parent");
    }
    children.push(child);
    pos = child.end;
  }
  return children;
};

/**
 * Overwrite an element with a `Void` element of the same total length and a
 * zeroed payload. The Void's size field takes the bytes the old ID and size
 * took, less the one-byte Void ID, up to the eight bytes a size can have.
 */
const voidElement = (out: Uint8Array, element: EbmlElement): void => {
  const end = element.end ?? fail("an element of unknown size");
  const sizeLength = Math.min(element.body - element.start - 1, 8);
  let size = end - element.start - 1 - sizeLength;
  out[element.start] = VOID;
  out.fill(0, element.start + 1, end);
  for (let i = sizeLength; i >= 1; i--) {
    out[element.start + i] = size % 256;
    size = Math.floor(size / 256);
  }
  out[element.start + 1] = at(out, element.start + 1) | (0x100 >> sizeLength);
};

/**
 * Void the children of `master` that `shouldVoid` picks, and its CRC-32,
 * which would no longer match. Whether anything changed.
 */
const voidChildren = (
  bytes: Uint8Array,
  out: Uint8Array,
  master: EbmlElement,
  shouldVoid: (child: EbmlElement) => boolean,
): boolean => {
  const children = ebmlChildren(bytes, master);
  const voided = children.filter(shouldVoid);
  for (const child of voided) {
    voidElement(out, child);
  }
  if (voided.length > 0) {
    for (const crc of children.filter((child) => child.id === CRC32)) {
      voidElement(out, crc);
    }
  }
  return voided.length > 0;
};

const elementIdValue = (bytes: Uint8Array, element: EbmlElement): number => {
  let id = 0;
  for (let pos = element.body; pos < (element.end ?? element.body); pos++) {
    id = id * 256 + at(bytes, pos);
  }
  return id;
};

/** A Seek entry that points at an element this stripper voids. */
const seeksMetadata = (bytes: Uint8Array, seek: EbmlElement): boolean =>
  seek.id === SEEK &&
  ebmlChildren(bytes, seek).some(
    (child) => child.id === SEEK_ID && METADATA_ELEMENTS.has(elementIdValue(bytes, child)),
  );

/**
 * Where a Cluster of unknown size (as a live recorder such as the browser's
 * MediaRecorder writes) ends: at the next level-1 element, or the end of the
 * segment. A last block cut off by the end of the file ends it too.
 */
const unknownClusterEnd = (bytes: Uint8Array, cluster: EbmlElement, limit: number): number => {
  let pos = cluster.body;
  while (pos < limit) {
    const child = ebmlElementAt(bytes, pos, limit);
    if (child === "cut") {
      return limit;
    }
    if (SEGMENT_CHILDREN.has(child.id)) {
      return pos;
    }
    if (child.end === undefined) {
      return fail("an element of unknown size in a cluster");
    }
    if (child.end >= limit) {
      return limit;
    }
    pos = child.end;
  }
  return limit;
};

/**
 * The segment: Tags and Attachments become Void, as do the descriptive
 * Info fields, track names and the SeekHead entries pointing at what was
 * voided. Clusters, Cues, Tracks and Chapters stay. A Cluster cut off by the
 * end of the file is kept, as a browser plays it as far as it goes. Where the
 * segment ends.
 */
const walkSegment = (bytes: Uint8Array, out: Uint8Array, segment: EbmlElement): number => {
  const limit = Math.min(segment.end ?? bytes.length, bytes.length);
  let sawTracks = false;
  let changed = false;
  const checksums: EbmlElement[] = [];
  let pos = segment.body;
  while (pos < limit) {
    const child = ebmlElementAt(bytes, pos, limit);
    if (child === "cut") {
      return fail("an element header runs past the end");
    }
    if (segment.end === undefined && (child.id === EBML || child.id === SEGMENT)) {
      // A segment of unknown size ends where the next file is chained on.
      return pos;
    }
    if (child.id === CLUSTER) {
      pos =
        child.end === undefined
          ? unknownClusterEnd(bytes, child, limit)
          : Math.min(child.end, limit);
      continue;
    }
    if (child.end === undefined || child.end > limit) {
      return fail("an element runs past the segment");
    }
    if (METADATA_ELEMENTS.has(child.id)) {
      voidElement(out, child);
      changed = true;
    } else if (child.id === INFO) {
      changed = voidChildren(bytes, out, child, (field) => INFO_METADATA.has(field.id)) || changed;
    } else if (child.id === TRACKS) {
      sawTracks = true;
      const renamed = ebmlChildren(bytes, child)
        .filter((entry) => entry.id === TRACK_ENTRY)
        .map((entry) => voidChildren(bytes, out, entry, (field) => field.id === TRACK_NAME));
      if (renamed.some(Boolean)) {
        voidChildren(bytes, out, child, (entry) => entry.id === CRC32);
        changed = true;
      }
    } else if (child.id === SEEK_HEAD) {
      changed = voidChildren(bytes, out, child, (seek) => seeksMetadata(bytes, seek)) || changed;
    } else if (child.id === CRC32) {
      checksums.push(child);
    }
    pos = child.end;
  }
  if (!sawTracks) {
    fail("a segment has no Tracks");
  }
  if (changed) {
    for (const crc of checksums) {
      voidElement(out, crc);
    }
  }
  return limit;
};

/** The DocType of an EBML header, which must name Matroska or WebM. */
const isMatroskaHeader = (bytes: Uint8Array, header: EbmlElement): boolean =>
  ebmlChildren(bytes, header).some((child) => {
    if (child.id !== DOC_TYPE || child.end === undefined || child.end - child.body > 16) {
      return false;
    }
    const docType = String.fromCharCode(...bytes.subarray(child.body, child.end)).replace(
      /\0+$/,
      "",
    );
    return docType === "webm" || docType === "matroska";
  });

const stripWebm = (bytes: Uint8Array): Strip => {
  const out = bytes.slice();
  let sawSegment = false;
  let pos = 0;
  while (pos < bytes.length) {
    const element = ebmlElementAt(bytes, pos, bytes.length);
    if (element === "cut") {
      return fail("an element header runs past the end");
    }
    if (element.id === SEGMENT) {
      sawSegment = true;
      pos = walkSegment(bytes, out, element);
      continue;
    }
    if (element.end === undefined || element.end > bytes.length) {
      return fail("an element runs past the end");
    }
    if (element.id === EBML) {
      if (!isMatroskaHeader(bytes, element)) {
        return fail("not a Matroska or WebM document");
      }
    } else if (element.id !== VOID && element.id !== CRC32) {
      return fail("an unknown top-level element");
    }
    pos = element.end;
  }
  if (!sawSegment) {
    return fail("has no segment");
  }
  return ok({ kind: "Stripped", format: "webm", bytes: out });
};

// --- Dispatch ----------------------------------------------------------------

/** The container `bytes` starts like, from its magic numbers. */
const containerOf = (bytes: Uint8Array): VideoContainer | undefined => {
  if (u32be(bytes, 0) === EBML && bytes.length >= 4) {
    return "webm";
  }
  return bytes.length >= 8 && MP4_FIRST_BOXES.has(u32be(bytes, 4)) ? "mp4" : undefined;
};

const STRIPPERS: Readonly<Record<VideoContainer, (bytes: Uint8Array) => Strip>> = {
  mp4: stripMp4,
  webm: stripWebm,
};

export const VideoMetadata = {
  /**
   * Rewrite an MP4 / QuickTime or WebM / Matroska file without its metadata,
   * in place and at the same length, judged by the bytes, not a declared
   * type. `UnknownFormat` for anything else; `MalformedVideo` when the
   * container cannot be walked, so that nothing is passed on unstripped.
   */
  strip: (bytes: Uint8Array): Result<VideoMetadataStrip, MalformedVideo> => {
    const format = containerOf(bytes);
    if (!format) {
      return ok({ kind: "UnknownFormat" });
    }
    try {
      return STRIPPERS[format](bytes);
    } catch (error) {
      if (error instanceof Malformed) {
        return err({ kind: "MalformedVideo", format, reason: error.message });
      }
      throw error;
    }
  },
} as const;
