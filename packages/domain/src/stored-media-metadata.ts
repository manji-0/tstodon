import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { ImageMetadata, type MalformedImage } from "./image-metadata";
import type { RepositoryError } from "./repository-error";
import { VideoMetadata, type MalformedVideo } from "./video-metadata";

/**
 * The stored objects the backfill walks, in the order it takes them: media
 * attachment originals (and the legacy copy the rekey job may keep), then
 * avatars, then headers. Previews are not walked: each is a WebP the `IMAGES`
 * binding encoded from an original already stripped on upload.
 */
const StoredMediaSourceSchema = z.union([
  z.literal("attachments"),
  z.literal("avatars"),
  z.literal("headers"),
]);

export type StoredMediaSource = z.infer<typeof StoredMediaSourceSchema>;

const SOURCES = [
  "attachments",
  "avatars",
  "headers",
] as const satisfies ReadonlyArray<StoredMediaSource>;

const count = z.number().int().min(0).default(0);

/**
 * What the backfill did with the objects it read, summed over a run: rewritten
 * without their metadata, found clean (left byte for byte, not written),
 * missing from the bucket, left as they are because their container could not
 * be read or they are over the size cap, and left for a later run because
 * reading or writing them failed.
 */
const StoredMediaTallySchema = z.object({
  stripped: count,
  unchanged: count,
  missing: count,
  unreadable: count,
  tooLarge: count,
  deferred: count,
});

export type StoredMediaTally = z.infer<typeof StoredMediaTallySchema>;

const EMPTY_TALLY: StoredMediaTally = {
  stripped: 0,
  unchanged: 0,
  missing: 0,
  unreadable: 0,
  tooLarge: 0,
  deferred: 0,
};

/**
 * A row whose stored objects are not known to be free of metadata: an
 * attachment (`id` is its id; its current key first, then a kept legacy copy)
 * or a profile's avatar or header (`id` is the account id, one key).
 */
export type UnstrippedMedia = Readonly<{ id: string; objectKeys: ReadonlyArray<string> }>;

/** The next `limit` rows of `source` after `afterId` (empty for the first) to strip, in id order. */
export type ListUnstrippedMedia = (
  source: StoredMediaSource,
  afterId: string,
  limit: number,
) => Promise<Result<ReadonlyArray<UnstrippedMedia>, RepositoryError>>;

/**
 * A stored object as read for stripping. `replace` writes new bytes at the
 * same key, keeping the object's content type, and resolves false when the
 * object changed since it was read (nothing is written then).
 */
export type StoredMediaObject =
  | Readonly<{
      kind: "Found";
      bytes: Uint8Array;
      replace: (bytes: Uint8Array) => Promise<boolean>;
    }>
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "TooLarge"; size: number }>;

/** Read the object at `objectKey`, unless it holds more than `maxBytes`. */
export type ReadStoredMedia = (objectKey: string, maxBytes: number) => Promise<StoredMediaObject>;

/**
 * What a row's objects are now: `Clean` (stripped, found clean, or gone), or
 * `PassedOver` with why one of them keeps its bytes.
 */
export type StoredMediaMark =
  | Readonly<{ kind: "Clean" }>
  | Readonly<{ kind: "PassedOver"; reason: string }>;

/**
 * Record `mark` on a row of `source`, if it still holds the key it was listed
 * with (`media.objectKeys[0]`); a row that moved or went is left alone.
 * `size` is the byte size of the object now at that key (the rewrite when
 * stripped, 0 when missing), which the row records with the mark.
 */
export type MarkStoredMedia = (
  source: StoredMediaSource,
  media: UnstrippedMedia,
  mark: StoredMediaMark,
  size: number,
) => Promise<Result<void, RepositoryError>>;

/** The rewrite of one stored object: new bytes, or none needed. */
export type StoredMediaStrip =
  | Readonly<{ kind: "Stripped"; bytes: Uint8Array }>
  | Readonly<{ kind: "Unchanged" }>;

/** What happened to one object, for the log. */
export type StoredMediaOutcome =
  | Readonly<{ kind: "Stripped" }>
  | Readonly<{ kind: "Unchanged" }>
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "Unreadable"; error: MalformedImage | MalformedVideo }>
  | Readonly<{ kind: "TooLarge"; size: number }>
  | Readonly<{ kind: "Deferred"; reason: string }>;

/** An object the log should name: anything but a clean or stripped one. */
export type StoredMediaReport = Readonly<{
  source: StoredMediaSource;
  id: string;
  objectKey: string;
  outcome: StoredMediaOutcome;
}>;

/** Where a run stands: the rows of `source` after `afterId` are next. */
export type StoredMediaCursor = Readonly<{ source: StoredMediaSource; afterId: string }>;

/**
 * One page of the backfill: what it did, the rows it went through, the
 * objects worth logging, and where the next page starts (undefined once the
 * headers are done).
 */
export type StoredMediaPass = Readonly<{
  scanned: number;
  tally: StoredMediaTally;
  reports: ReadonlyArray<StoredMediaReport>;
  next: StoredMediaCursor | undefined;
}>;

/** How much one page may do, so a queue invocation stays within Workers' memory and CPU. */
export type StoredMediaLimits = Readonly<{
  /** Rows listed per page. */
  rows: number;
  /** Bytes read per page; once spent, the remaining rows go to the next page. */
  bytes: number;
  /** An object over this many bytes is passed over (`TooLarge`), not read. */
  objectBytes: number;
}>;

const MIB = 1024 * 1024;

/**
 * Ten rows, 64 MiB read and 32 MiB per object: an object is read whole and
 * its rewrite is a copy, so one object costs about twice its size in memory
 * (Workers allow 128 MB), and the strip is a linear walk of headers. Every
 * image upload (16 MiB cap) fits; a video over 32 MiB (the upload cap is 99
 * MiB) is passed over.
 */
const DEFAULT_LIMITS: StoredMediaLimits = { rows: 10, bytes: 64 * MIB, objectBytes: 32 * MIB };

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
};

const rewriteOf = (stored: Uint8Array, stripped: Uint8Array): StoredMediaStrip =>
  sameBytes(stripped, stored) ? { kind: "Unchanged" } : { kind: "Stripped", bytes: stripped };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : "UnknownError";

/**
 * The bytes to store in place of a stored object, judged by the bytes as on
 * upload: an image or video container is stripped, and `Unchanged` when the
 * rewrite is byte for byte the stored file (already clean, or a format that
 * carries nothing to strip, such as GIF). Unlike an upload, the declared type
 * is not checked: the object is already public, and only its metadata goes.
 */
const strip = (bytes: Uint8Array): Result<StoredMediaStrip, MalformedImage | MalformedVideo> => {
  const image = ImageMetadata.strip(bytes);
  if (image.isErr()) {
    return err(image.error);
  }
  if (image.value.kind === "Stripped") {
    return ok(rewriteOf(bytes, image.value.bytes));
  }
  const video = VideoMetadata.strip(bytes);
  if (video.isErr()) {
    return err(video.error);
  }
  return ok(
    video.value.kind === "Stripped" ? rewriteOf(bytes, video.value.bytes) : { kind: "Unchanged" },
  );
};

/**
 * Strip one object; resolves to what happened, how many bytes were read, and
 * the size of the object now stored at the key (undefined when deferred: it
 * is read again).
 */
const stripObject = async (
  read: ReadStoredMedia,
  objectKey: string,
  limits: StoredMediaLimits,
): Promise<
  Readonly<{ outcome: StoredMediaOutcome; bytesRead: number; size: number | undefined }>
> => {
  try {
    const object = await read(objectKey, limits.objectBytes);
    switch (object.kind) {
      case "Missing":
        return { outcome: { kind: "Missing" }, bytesRead: 0, size: 0 };
      case "TooLarge":
        return {
          outcome: { kind: "TooLarge", size: object.size },
          bytesRead: 0,
          size: object.size,
        };
      case "Found": {
        const bytesRead = object.bytes.length;
        const rewrite = strip(object.bytes);
        if (rewrite.isErr()) {
          return {
            outcome: { kind: "Unreadable", error: rewrite.error },
            bytesRead,
            size: bytesRead,
          };
        }
        if (rewrite.value.kind === "Unchanged") {
          return { outcome: { kind: "Unchanged" }, bytesRead, size: bytesRead };
        }
        const replaced = await object.replace(rewrite.value.bytes);
        return replaced
          ? { outcome: { kind: "Stripped" }, bytesRead, size: rewrite.value.bytes.length }
          : {
              outcome: { kind: "Deferred", reason: "ObjectChangedSinceRead" },
              bytesRead,
              size: undefined,
            };
      }
    }
  } catch (error) {
    return {
      outcome: { kind: "Deferred", reason: reasonOf(error) },
      bytesRead: 0,
      size: undefined,
    };
  }
};

const TALLY_KEY = {
  Stripped: "stripped",
  Unchanged: "unchanged",
  Missing: "missing",
  Unreadable: "unreadable",
  TooLarge: "tooLarge",
  Deferred: "deferred",
} as const satisfies Record<StoredMediaOutcome["kind"], keyof StoredMediaTally>;

const passedOverReason = (outcome: StoredMediaOutcome): string | undefined => {
  switch (outcome.kind) {
    case "Unreadable":
      return `${outcome.error.kind}: ${outcome.error.reason}`;
    case "TooLarge":
      return `TooLarge: ${outcome.size} bytes`;
    default:
      return undefined;
  }
};

/**
 * The mark a row gets from its objects' outcomes: none while one is deferred
 * (a later run reads it again), `PassedOver` when one keeps its bytes, else
 * `Clean`.
 */
const markOf = (outcomes: ReadonlyArray<StoredMediaOutcome>): StoredMediaMark | undefined => {
  if (outcomes.some((outcome) => outcome.kind === "Deferred")) {
    return undefined;
  }
  const reason = outcomes.map(passedOverReason).find((value) => value !== undefined);
  return reason === undefined ? { kind: "Clean" } : { kind: "PassedOver", reason };
};

const nextSource = (source: StoredMediaSource): StoredMediaSource | undefined =>
  SOURCES[SOURCES.indexOf(source) + 1];

export const StoredMediaMetadata = {
  sourceSchema: StoredMediaSourceSchema,
  tallySchema: StoredMediaTallySchema,
  emptyTally: EMPTY_TALLY,
  limits: DEFAULT_LIMITS,
  strip,

  /** Sum two tallies, counter by counter. */
  addTally: (a: StoredMediaTally, b: StoredMediaTally): StoredMediaTally => ({
    stripped: a.stripped + b.stripped,
    unchanged: a.unchanged + b.unchanged,
    missing: a.missing + b.missing,
    unreadable: a.unreadable + b.unreadable,
    tooLarge: a.tooLarge + b.tooLarge,
    deferred: a.deferred + b.deferred,
  }),

  /**
   * One page of the backfill from `cursor`: strip each listed row's objects
   * in place, skip the write when the bytes are already clean, and mark the
   * row so no later run reads it again. A page that lists a full batch, or
   * stops early on its byte budget, continues after its last row; a short
   * page moves on to the next source. A row whose mark fails to record is
   * read again by a later run, which finds it clean. The mark carries the
   * size of the row's object as now stored, so a rewrite keeps the recorded
   * size true to the bucket.
   */
  pass: async (
    deps: Readonly<{ list: ListUnstrippedMedia; read: ReadStoredMedia; mark: MarkStoredMedia }>,
    cursor: StoredMediaCursor,
    limits: StoredMediaLimits = DEFAULT_LIMITS,
  ): Promise<Result<StoredMediaPass, RepositoryError>> => {
    const rows = await deps.list(cursor.source, cursor.afterId, limits.rows);
    if (rows.isErr()) {
      return err(rows.error);
    }
    const tally: Record<keyof StoredMediaTally, number> = { ...EMPTY_TALLY };
    const reports: StoredMediaReport[] = [];
    let bytesRead = 0;
    let scanned = 0;
    let lastId = cursor.afterId;
    for (const media of rows.value) {
      if (bytesRead >= limits.bytes) {
        break;
      }
      const outcomes: StoredMediaOutcome[] = [];
      let size: number | undefined;
      for (const [index, objectKey] of media.objectKeys.entries()) {
        const done = await stripObject(deps.read, objectKey, limits);
        if (index === 0) {
          size = done.size;
        }
        bytesRead += done.bytesRead;
        tally[TALLY_KEY[done.outcome.kind]] += 1;
        outcomes.push(done.outcome);
        if (done.outcome.kind !== "Stripped" && done.outcome.kind !== "Unchanged") {
          reports.push({ source: cursor.source, id: media.id, objectKey, outcome: done.outcome });
        }
      }
      const mark = markOf(outcomes);
      // No object was deferred, so the row's own object has a size.
      if (mark && size !== undefined) {
        const marked = await deps.mark(cursor.source, media, mark, size);
        if (marked.isErr()) {
          reports.push({
            source: cursor.source,
            id: media.id,
            objectKey: media.objectKeys[0] ?? "",
            outcome: { kind: "Deferred", reason: `MarkFailed: ${marked.error.message}` },
          });
        }
      }
      scanned += 1;
      lastId = media.id;
    }
    const more = scanned < rows.value.length || rows.value.length >= limits.rows;
    const following = nextSource(cursor.source);
    const next: StoredMediaCursor | undefined = more
      ? { source: cursor.source, afterId: lastId }
      : following === undefined
        ? undefined
        : { source: following, afterId: "" };
    return ok({ scanned, tally, reports, next });
  },
} as const;
