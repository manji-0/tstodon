/**
 * Minimal MP4 and WebM files built byte by byte, carrying the metadata a
 * phone, an action camera or an editor writes: QuickTime user data with a
 * `©xyz` location, Apple's `mdta` keys with `com.apple.quicktime.location.ISO6709`,
 * XMP, a GoPro-style timed GPS track, Matroska Tags, a title and a date.
 */

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
const be64 = (value: number): Uint8Array =>
  join(be32(Math.floor(value / 0x1_0000_0000)), be32(value >>> 0));

/** Text the video fixtures hide, none of which may survive stripping. */
export const VIDEO_SECRETS = {
  location: "+35.6895+139.6917",
  make: "SecretPhoneMaker",
  model: "SecretModel X",
  date: "2026-11-08T12:34:56Z",
  xmp: "secret-xmp",
  trackGps: "secret-track-gps",
  trackName: "SecretTrackName",
  title: "SecretTitle",
  cover: "secret-cover",
} as const;

/** The creation and modification time written into mvhd, tkhd and mdhd. */
export const MP4_TIME = 0xe1234567;

const XMP_PACKET = ascii(
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description>${VIDEO_SECRETS.xmp}</rdf:Description></x:xmpmeta>`,
);

const XMP_UUID = Uint8Array.of(
  0xbe,
  0x7a,
  0xcf,
  0xcb,
  0x97,
  0xa9,
  0x42,
  0xe8,
  0x9c,
  0x71,
  0x99,
  0x94,
  0x91,
  0xe3,
  0xaf,
  0xac,
);

// --- MP4 ----------------------------------------------------------------------

export const mp4Box = (type: string, ...payload: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = join(...payload);
  return join(be32(body.length + 8), ascii(type), body);
};

/** A box with a 64-bit `largesize`. */
const largeBox = (type: string, ...payload: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = join(...payload);
  return join(be32(1), ascii(type), be64(body.length + 16), body);
};

const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...payload: ReadonlyArray<Uint8Array>
): Uint8Array =>
  mp4Box(type, Uint8Array.of(version, flags >> 16, (flags >> 8) & 0xff, flags & 0xff), ...payload);

/** Creation and modification times, 32 or 64 bits. */
const times = (version: number): Uint8Array =>
  version === 1 ? join(be64(MP4_TIME), be64(MP4_TIME)) : join(be32(MP4_TIME), be32(MP4_TIME));

const MATRIX = join(
  be32(0x10000),
  be32(0),
  be32(0),
  be32(0),
  be32(0x10000),
  be32(0),
  be32(0),
  be32(0),
  be32(0x40000000),
);

const mvhd = (version: number): Uint8Array =>
  fullBox(
    "mvhd",
    version,
    0,
    times(version),
    be32(1000),
    version === 1 ? be64(2000) : be32(2000),
    be32(0x10000),
    be16(0x100),
    new Uint8Array(10),
    MATRIX,
    new Uint8Array(24),
    be32(3),
  );

const tkhd = (version: number, id: number): Uint8Array =>
  fullBox(
    "tkhd",
    version,
    3,
    times(version),
    be32(id),
    be32(0),
    version === 1 ? be64(2000) : be32(2000),
    new Uint8Array(8),
    be16(0),
    be16(0),
    be16(0),
    be16(0),
    MATRIX,
    be32(16 << 16),
    be32(16 << 16),
  );

const mdhd = (version: number): Uint8Array =>
  fullBox(
    "mdhd",
    version,
    0,
    times(version),
    be32(1000),
    version === 1 ? be64(2000) : be32(2000),
    be16(0x55c4),
    be16(0),
  );

const hdlr = (handler: string, name: string): Uint8Array =>
  fullBox("hdlr", 0, 0, be32(0), ascii(handler), new Uint8Array(12), ascii(`${name}\0`));

type SampleTable = Readonly<{
  /** Sample sizes in decode order. */
  sizes: ReadonlyArray<number>;
  /** Samples per chunk, with each chunk's file offset. */
  chunks: ReadonlyArray<Readonly<{ offset: number; samples: number }>>;
  co64?: boolean;
}>;

const stbl = (entry: string, table: SampleTable): Uint8Array =>
  mp4Box(
    "stbl",
    fullBox("stsd", 0, 0, be32(1), mp4Box(entry, new Uint8Array(6), be16(1))),
    fullBox("stts", 0, 0, be32(1), be32(table.sizes.length), be32(1000)),
    fullBox(
      "stsc",
      0,
      0,
      be32(table.chunks.length),
      ...table.chunks.map((chunk, index) => join(be32(index + 1), be32(chunk.samples), be32(1))),
    ),
    fullBox("stsz", 0, 0, be32(0), be32(table.sizes.length), ...table.sizes.map(be32)),
    table.co64
      ? fullBox("co64", 0, 0, be32(table.chunks.length), ...table.chunks.map((c) => be64(c.offset)))
      : fullBox(
          "stco",
          0,
          0,
          be32(table.chunks.length),
          ...table.chunks.map((c) => be32(c.offset)),
        ),
  );

const udtaText = (type: string, text: string): Uint8Array =>
  mp4Box(type, be16(text.length), be16(0x15c7), ascii(text));

/** QuickTime user data as an iPhone or Android camera app writes it. */
const movieUdta = (): Uint8Array =>
  mp4Box(
    "udta",
    udtaText("©xyz", `${VIDEO_SECRETS.location}/`),
    udtaText("©mak", VIDEO_SECRETS.make),
    udtaText("©mod", VIDEO_SECRETS.model),
    udtaText("©day", VIDEO_SECRETS.date),
    mp4Box("XMP_", XMP_PACKET),
  );

/** Apple's `mdta` metadata: keys, then values by key index. */
const quickTimeMeta = (): Uint8Array => {
  const keys = [
    "com.apple.quicktime.location.ISO6709",
    "com.apple.quicktime.make",
    "com.apple.quicktime.creationdate",
  ];
  const values = [`${VIDEO_SECRETS.location}+040.000/`, VIDEO_SECRETS.make, VIDEO_SECRETS.date];
  return mp4Box(
    "meta",
    hdlr("mdta", ""),
    fullBox(
      "keys",
      0,
      0,
      be32(keys.length),
      ...keys.map((key) => join(be32(key.length + 8), ascii("mdta"), ascii(key))),
    ),
    mp4Box(
      "ilst",
      ...values.map((value, index) =>
        join(
          be32(value.length + 24),
          be32(index + 1),
          mp4Box("data", be32(1), be32(0), ascii(value)),
        ),
      ),
    ),
  );
};

/** The video frames' bytes, recognisable after stripping. */
export const videoFrame = (index: number): Uint8Array => ascii(`VIDEO-FRAME-${index}-PAYLOAD`);

/** A timed GPS sample, as GoPro's GPMF track carries. */
const gpsSample = (index: number): Uint8Array =>
  ascii(`${VIDEO_SECRETS.trackGps}-${index}-${VIDEO_SECRETS.location}`);

export type Mp4Options = Readonly<{
  /** `moov` before `mdat` (the default) or after it. */
  faststart?: boolean;
  /** Version 1 (64-bit) mvhd, tkhd and mdhd, `co64` offsets and a 64-bit mdat size. */
  large?: boolean;
  /** A GoPro-style timed metadata track with GPS samples. */
  gpsTrack?: boolean;
  /** No user data, `meta`, XMP or GPS track: only the times to strip. */
  bare?: boolean;
}>;

/**
 * An MP4 with a video track of four frames in two chunks, optionally a
 * timed GPS track interleaved with it, all metadata in `moov` (user data,
 * QuickTime keys, track user data with a name), and a top-level XMP `uuid`.
 */
export const mp4WithMetadata = (options: Mp4Options = {}): Uint8Array => {
  const faststart = options.faststart ?? true;
  const large = options.large ?? false;
  const bare = options.bare ?? false;
  const gpsTrack = !bare && (options.gpsTrack ?? true);
  const version = large ? 1 : 0;
  const ftyp = mp4Box("ftyp", ascii("isom"), be32(0x200), ascii("isomiso2avc1mp41"));
  const uuid = bare ? new Uint8Array() : mp4Box("uuid", XMP_UUID, XMP_PACKET);
  // The interleaved payload: video chunk, GPS chunk, video chunk, GPS chunk.
  const frames = [0, 1, 2, 3].map(videoFrame);
  const gps = [0, 1].map(gpsSample);
  const pieces = gpsTrack
    ? [frames[0], frames[1], gps[0], frames[2], frames[3], gps[1]]
    : [frames[0], frames[1], frames[2], frames[3]];
  const payload = join(...pieces.map((piece) => piece ?? new Uint8Array()));
  const moovFor = (mdatPayloadAt: number): Uint8Array => {
    let at = mdatPayloadAt;
    const offsets = pieces.map((piece) => {
      const offset = at;
      at += piece?.length ?? 0;
      return offset;
    });
    const videoChunks = gpsTrack
      ? [
          { offset: offsets[0] ?? 0, samples: 2 },
          { offset: offsets[3] ?? 0, samples: 2 },
        ]
      : [{ offset: offsets[0] ?? 0, samples: 4 }];
    const videoTrak = mp4Box(
      "trak",
      tkhd(version, 1),
      mp4Box(
        "mdia",
        mdhd(version),
        hdlr("vide", "VideoHandler"),
        mp4Box(
          "minf",
          fullBox("vmhd", 0, 1, new Uint8Array(8)),
          stbl("avc1", { sizes: frames.map((f) => f.length), chunks: videoChunks, co64: large }),
        ),
      ),
      ...(bare
        ? []
        : [
            mp4Box(
              "udta",
              mp4Box("name", ascii(VIDEO_SECRETS.trackName)),
              udtaText("©xyz", VIDEO_SECRETS.location),
            ),
          ]),
    );
    const gpsTrak = mp4Box(
      "trak",
      tkhd(version, 2),
      mp4Box(
        "mdia",
        mdhd(version),
        hdlr("meta", "GoPro MET"),
        mp4Box(
          "minf",
          fullBox("nmhd", 0, 0),
          stbl("gpmd", {
            sizes: gps.map((g) => g.length),
            chunks: [
              { offset: offsets[2] ?? 0, samples: 1 },
              { offset: offsets[5] ?? 0, samples: 1 },
            ],
            co64: large,
          }),
        ),
      ),
    );
    return mp4Box(
      "moov",
      mvhd(version),
      videoTrak,
      ...(gpsTrack ? [gpsTrak] : []),
      ...(bare ? [] : [movieUdta(), quickTimeMeta()]),
    );
  };
  const mdatHeader = large ? 16 : 8;
  const mdatOf = (): Uint8Array => (large ? largeBox("mdat", payload) : mp4Box("mdat", payload));
  if (faststart) {
    const moovSize = moovFor(0).length;
    const moov = moovFor(ftyp.length + moovSize + uuid.length + mdatHeader);
    return join(ftyp, moov, uuid, mdatOf());
  }
  return join(ftyp, uuid, mdatOf(), moovFor(ftyp.length + uuid.length + mdatHeader));
};

/**
 * A fragmented MP4: an init `moov` (no samples, `mvex` with a default GPS
 * sample size, user data with a location) and one fragment whose video
 * `traf` counts from the `moof` and whose GPS `traf` gives no base, so its
 * data follows the video's.
 */
export const fragmentedMp4WithMetadata = (): Uint8Array => {
  const ftyp = mp4Box("ftyp", ascii("iso6"), be32(0), ascii("iso6mp41"));
  const emptyTable = { sizes: [], chunks: [] };
  const trak = (id: number, handler: string, entry: string): Uint8Array =>
    mp4Box(
      "trak",
      tkhd(0, id),
      mp4Box(
        "mdia",
        mdhd(0),
        hdlr(handler, ""),
        mp4Box("minf", fullBox("nmhd", 0, 0), stbl(entry, emptyTable)),
      ),
    );
  const gps = [0, 1].map(gpsSample);
  const gpsSize = gps[0]?.length ?? 0;
  const frames = [0, 1].map(videoFrame);
  const moov = mp4Box(
    "moov",
    mvhd(0),
    trak(1, "vide", "avc1"),
    trak(2, "meta", "gpmd"),
    mp4Box(
      "mvex",
      fullBox("trex", 0, 0, be32(1), be32(1), be32(0), be32(0), be32(0)),
      fullBox("trex", 0, 0, be32(2), be32(1), be32(0), be32(gpsSize), be32(0)),
    ),
    movieUdta(),
  );
  const moofFor = (videoDataOffset: number): Uint8Array =>
    mp4Box(
      "moof",
      fullBox("mfhd", 0, 0, be32(1)),
      mp4Box(
        "traf",
        fullBox("tfhd", 0, 0x20000, be32(1)),
        fullBox(
          "trun",
          0,
          0x201,
          be32(frames.length),
          be32(videoDataOffset),
          ...frames.map((f) => be32(f.length)),
        ),
      ),
      mp4Box("traf", fullBox("tfhd", 0, 0, be32(2)), fullBox("trun", 0, 0, be32(gps.length))),
      mp4Box("udta", udtaText("©xyz", VIDEO_SECRETS.location)),
    );
  const moofSize = moofFor(0).length;
  const moof = moofFor(moofSize + 8);
  const mdat = mp4Box("mdat", ...frames, ...gps);
  return join(ftyp, moov, moof, mdat);
};

/** The EXIF item payload of `withFileMeta("pict")`: a TIFF header offset, then text. */
export const EXIF_ITEM_SECRET = "secret-exif-item";

/**
 * `mp4` followed by a file-level `meta` box: a HEIF-style item store
 * (handler `pict`) listing an EXIF item in an `mdat` after it, or iTunes
 * metadata (handler `mdir`) with a location in `ilst`.
 */
export const withFileMeta = (mp4: Uint8Array, handler: "pict" | "mdir"): Uint8Array => {
  const exif = join(
    be32(0),
    ascii("MM\0*"),
    be32(8),
    ascii(`${EXIF_ITEM_SECRET}-${VIDEO_SECRETS.location}`),
  );
  const metaFor = (offset: number): Uint8Array =>
    handler === "pict"
      ? fullBox(
          "meta",
          0,
          0,
          hdlr("pict", ""),
          fullBox("iinf", 0, 0, be16(1), fullBox("infe", 2, 0, be16(1), be16(0), ascii("Exif\0"))),
          fullBox(
            "iloc",
            0,
            0,
            Uint8Array.of(0x44, 0x00),
            be16(1),
            be16(1),
            be16(0),
            be16(1),
            be32(offset),
            be32(exif.length),
          ),
        )
      : fullBox(
          "meta",
          0,
          0,
          hdlr("mdir", ""),
          mp4Box(
            "ilst",
            mp4Box("©xyz", mp4Box("data", be32(1), be32(0), ascii(VIDEO_SECRETS.location))),
          ),
        );
  if (handler === "mdir") {
    return join(mp4, metaFor(0));
  }
  const metaSize = metaFor(0).length;
  return join(mp4, metaFor(mp4.length + metaSize + 8), mp4Box("mdat", exif));
};

/** The boxes of an MP4 as `path:type` with their offsets, walked like a reader. */
export type Mp4BoxInfo = Readonly<{ path: string; start: number; body: number; end: number }>;

const MP4_CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "udta",
  "moof",
  "traf",
  "mvex",
]);

export const mp4BoxTree = (
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
  prefix = "",
): Mp4BoxInfo[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Mp4BoxInfo[] = [];
  for (let pos = start; pos + 8 <= end;) {
    const size32 = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const body = pos + (size32 === 1 ? 16 : 8);
    const size =
      size32 === 1
        ? view.getUint32(pos + 8) * 0x1_0000_0000 + view.getUint32(pos + 12)
        : size32 === 0
          ? end - pos
          : size32;
    const boxEnd = Math.min(pos + size, end);
    const path = prefix ? `${prefix}/${type}` : type;
    boxes.push({ path, start: pos, body, end: boxEnd });
    if (MP4_CONTAINERS.has(type)) {
      boxes.push(...mp4BoxTree(bytes, body, boxEnd, path));
    }
    if (size < 8) {
      break;
    }
    pos += size;
  }
  return boxes;
};

/** The chunk offsets (`stco` or `co64`) of every track, in track order. */
export const chunkOffsets = (bytes: Uint8Array): ReadonlyArray<ReadonlyArray<number>> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return mp4BoxTree(bytes)
    .filter(
      (b) =>
        b.path === "moov/trak/mdia/minf/stbl/stco" || b.path === "moov/trak/mdia/minf/stbl/co64",
    )
    .map((b) => {
      const large = b.path.endsWith("co64");
      return Array.from({ length: view.getUint32(b.body + 4) }, (_, i) =>
        large
          ? view.getUint32(b.body + 8 + i * 8) * 0x1_0000_0000 + view.getUint32(b.body + 12 + i * 8)
          : view.getUint32(b.body + 8 + i * 4),
      );
    });
};

// --- WebM ---------------------------------------------------------------------

const idBytes = (id: number): Uint8Array => {
  const bytes: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) {
    bytes.unshift(value % 256);
  }
  return Uint8Array.from(bytes);
};

/** An EBML size in `length` bytes (the shortest that fits by default). */
const ebmlSize = (size: number, length?: number): Uint8Array => {
  const width = length ?? [1, 2, 3, 4, 5, 6, 7, 8].find((w) => size < 2 ** (7 * w) - 1) ?? 8;
  const out = new Uint8Array(width);
  let value = size;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  out[0] = (out[0] ?? 0) | (0x100 >> width);
  return out;
};

/** The 8-byte unknown size a live recorder writes. */
const UNKNOWN_SIZE = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

export const ebml = (id: number, ...payload: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = join(...payload);
  return join(idBytes(id), ebmlSize(body.length), body);
};

/** An element with an 8-byte size field, as some muxers write for masters. */
const ebmlWide = (id: number, ...payload: ReadonlyArray<Uint8Array>): Uint8Array => {
  const body = join(...payload);
  return join(idBytes(id), ebmlSize(body.length, 8), body);
};

const uint = (id: number, value: number): Uint8Array =>
  ebml(id, value < 256 ? Uint8Array.of(value) : be32(value));
const text = (id: number, value: string): Uint8Array => ebml(id, ascii(value));

export const WEBM_IDS = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  cluster: 0x1f43b675,
  cues: 0x1c53bb6b,
  tags: 0x1254c367,
  attachments: 0x1941a469,
  title: 0x7ba9,
  dateUtc: 0x4461,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  trackName: 0x536e,
  void: 0xec,
  crc32: 0xbf,
} as const;

export const ebmlHeader = (docType: string): Uint8Array =>
  ebml(
    0x1a45dfa3,
    uint(0x4286, 1),
    uint(0x42f7, 1),
    uint(0x42f2, 4),
    uint(0x42f3, 8),
    text(0x4282, docType),
    uint(0x4287, 4),
    uint(0x4285, 2),
  );

const info = (): Uint8Array =>
  ebml(
    WEBM_IDS.info,
    ebml(WEBM_IDS.crc32, Uint8Array.of(1, 2, 3, 4)),
    uint(0x2ad7b1, 1_000_000),
    text(WEBM_IDS.muxingApp, "Lavf"),
    text(WEBM_IDS.writingApp, "Lavf"),
    text(WEBM_IDS.title, VIDEO_SECRETS.title),
    ebml(WEBM_IDS.dateUtc, be64(0x0a00_0000)),
    text(0x7384, `${VIDEO_SECRETS.make}.webm`),
  );

const tracks = (): Uint8Array =>
  ebml(
    WEBM_IDS.tracks,
    ebml(
      0xae,
      uint(0xd7, 1),
      uint(0x73c5, 1234),
      uint(0x83, 1),
      text(0x86, "V_VP8"),
      text(WEBM_IDS.trackName, VIDEO_SECRETS.trackName),
      ebml(0xe0, uint(0xb0, 16), uint(0xba, 16)),
    ),
  );

/** A cluster's payload: a timestamp and one SimpleBlock with a recognisable frame. */
export const clusterPayload = (index: number): Uint8Array =>
  join(uint(0xe7, index * 40), ebml(0xa3, Uint8Array.of(0x81, 0, 0, 0x80), videoFrame(index)));

const tags = (): Uint8Array =>
  ebmlWide(
    WEBM_IDS.tags,
    ebml(
      0x7373,
      ebml(0x63c0),
      ebml(0x67c8, text(0x45a3, "LOCATION"), text(0x4487, VIDEO_SECRETS.location)),
      ebml(0x67c8, text(0x45a3, "DATE_RECORDED"), text(0x4487, VIDEO_SECRETS.date)),
    ),
  );

const attachments = (): Uint8Array =>
  ebml(
    WEBM_IDS.attachments,
    ebml(
      0x61a7,
      text(0x466e, "cover.jpg"),
      text(0x4660, "image/jpeg"),
      text(0x465c, VIDEO_SECRETS.cover),
      uint(0x46ae, 7),
    ),
  );

const seek = (id: number, position: number): Uint8Array =>
  ebml(0x4dbb, ebml(0x53ab, idBytes(id)), ebml(0x53ac, be32(position)));

/**
 * A WebM as a muxer writes it: SeekHead, Info (with a CRC-32, a title, a
 * date and a file name), Tracks (a named track), two Clusters, Cues, Tags
 * with a location and Attachments, inside a Segment of known size.
 */
export const webmWithMetadata = (docType = "webm"): Uint8Array => {
  const level1 = (seekHead: Uint8Array): Uint8Array[] => {
    const infoElement = info();
    const tracksElement = tracks();
    const clusters = [
      ebml(WEBM_IDS.cluster, clusterPayload(0)),
      ebml(WEBM_IDS.cluster, clusterPayload(1)),
    ];
    const afterSeek = seekHead.length;
    const clusterAt = afterSeek + infoElement.length + tracksElement.length;
    const cues = ebml(
      WEBM_IDS.cues,
      ebml(0xbb, uint(0xb3, 0), ebml(0xb7, uint(0xf7, 1), ebml(0xf1, be32(clusterAt)))),
    );
    return [seekHead, infoElement, tracksElement, ...clusters, cues, tags(), attachments()];
  };
  const seekHeadFor = (positions: ReadonlyArray<number>): Uint8Array =>
    ebml(
      WEBM_IDS.seekHead,
      seek(WEBM_IDS.info, positions[1] ?? 0),
      seek(WEBM_IDS.tracks, positions[2] ?? 0),
      seek(WEBM_IDS.cues, positions[5] ?? 0),
      seek(WEBM_IDS.tags, positions[6] ?? 0),
      seek(WEBM_IDS.attachments, positions[7] ?? 0),
    );
  const positionsOf = (elements: ReadonlyArray<Uint8Array>): number[] => {
    let at = 0;
    return elements.map((element) => {
      const position = at;
      at += element.length;
      return position;
    });
  };
  const draft = level1(seekHeadFor([0, 0, 0, 0, 0, 0, 0, 0]));
  const elements = level1(seekHeadFor(positionsOf(draft)));
  return join(ebmlHeader(docType), ebmlWide(WEBM_IDS.segment, ...elements));
};

/**
 * A WebM as the browser's MediaRecorder writes it: a Segment and Clusters
 * of unknown size, no Cues, here followed by Tags that end the last Cluster.
 */
export const liveWebmWithMetadata = (): Uint8Array =>
  join(
    ebmlHeader("webm"),
    idBytes(WEBM_IDS.segment),
    UNKNOWN_SIZE,
    info(),
    tracks(),
    idBytes(WEBM_IDS.cluster),
    UNKNOWN_SIZE,
    clusterPayload(0),
    idBytes(WEBM_IDS.cluster),
    UNKNOWN_SIZE,
    clusterPayload(1),
    tags(),
  );

export type EbmlInfo = Readonly<{
  path: string;
  id: number;
  start: number;
  body: number;
  end: number;
}>;

const EBML_MASTERS: ReadonlySet<number> = new Set([
  0x1a45dfa3,
  WEBM_IDS.segment,
  WEBM_IDS.seekHead,
  0x4dbb,
  WEBM_IDS.info,
  WEBM_IDS.tracks,
  0xae,
  0xe0,
  WEBM_IDS.cluster,
  WEBM_IDS.cues,
  0xbb,
  0xb7,
  WEBM_IDS.tags,
  0x7373,
  0x67c8,
  WEBM_IDS.attachments,
  0x61a7,
]);

/** The elements of a WebM, walked like a reader (unknown sizes run to their parent's end). */
export const ebmlTree = (
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
  prefix = "",
): EbmlInfo[] => {
  const elements: EbmlInfo[] = [];
  const width = (first: number): number =>
    [1, 2, 3, 4, 5, 6, 7, 8].find((w) => first & (0x100 >> w)) ?? 0;
  for (let pos = start; pos < end;) {
    const idWidth = width(bytes[pos] ?? 0);
    let id = 0;
    for (let i = 0; i < idWidth; i++) {
      id = id * 256 + (bytes[pos + i] ?? 0);
    }
    const sizeAt = pos + idWidth;
    const sizeWidth = width(bytes[sizeAt] ?? 0);
    let size = (bytes[sizeAt] ?? 0) & (0xff >> sizeWidth);
    let unknown = size === 0xff >> sizeWidth;
    for (let i = 1; i < sizeWidth; i++) {
      unknown &&= bytes[sizeAt + i] === 0xff;
      size = size * 256 + (bytes[sizeAt + i] ?? 0);
    }
    const body = sizeAt + sizeWidth;
    if (idWidth === 0 || sizeWidth === 0) {
      throw new Error(`invalid element at ${pos}`);
    }
    const elementEnd = unknown ? end : body + size;
    const path = `${prefix}/${id.toString(16)}`;
    elements.push({ path, id, start: pos, body, end: elementEnd });
    if (EBML_MASTERS.has(id) && !(unknown && id === WEBM_IDS.cluster)) {
      elements.push(...ebmlTree(bytes, body, Math.min(elementEnd, end), path));
    }
    pos = unknown ? end : elementEnd;
  }
  return elements;
};

/**
 * A real file of a video upload type, for tests that only need an upload to
 * be accepted: its container is walked to strip the metadata.
 */
export const sampleVideoFor = (type: string): Uint8Array =>
  type === "video/webm" ? webmWithMetadata() : mp4WithMetadata();
