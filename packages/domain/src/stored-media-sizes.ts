import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./repository-error";

/**
 * The rows whose stored objects the size backfill walks, in the order it
 * takes them: media attachments (original and preview), avatars, headers,
 * then custom emoji images.
 */
const StoredMediaSizeSourceSchema = z.union([
  z.literal("attachments"),
  z.literal("avatars"),
  z.literal("headers"),
  z.literal("emojis"),
]);

export type StoredMediaSizeSource = z.infer<typeof StoredMediaSizeSourceSchema>;

const SOURCES = [
  "attachments",
  "avatars",
  "headers",
  "emojis",
] as const satisfies ReadonlyArray<StoredMediaSizeSource>;

const count = z.number().int().min(0).default(0);

/**
 * What the backfill did with the objects it looked up, summed over a run:
 * sized from their stored object, recorded as 0 because the object is gone,
 * and left for a later run because the lookup failed.
 */
const StoredMediaSizeTallySchema = z.object({
  sized: count,
  missing: count,
  deferred: count,
});

export type StoredMediaSizeTally = z.infer<typeof StoredMediaSizeTallySchema>;

const EMPTY_TALLY: StoredMediaSizeTally = { sized: 0, missing: 0, deferred: 0 };

/** Which of a row's objects a size belongs to: an attachment's preview, or the row's own object. */
const StoredMediaSlotSchema = z.union([z.literal("file"), z.literal("preview")]);

export type StoredMediaSlot = z.infer<typeof StoredMediaSlotSchema>;

/** One stored object of unknown size, at `objectKey`. */
export type UnsizedObject = Readonly<{ slot: StoredMediaSlot; objectKey: string }>;

/**
 * A row with stored objects of unknown size: an attachment (`id` is its id;
 * its original, its preview or both), a profile's avatar or header (`id` is
 * the account id) or a custom emoji (`id` is its id).
 */
export type UnsizedMedia = Readonly<{
  source: StoredMediaSizeSource;
  id: string;
  objects: ReadonlyArray<UnsizedObject>;
}>;

/** Where a run stands: the rows of `source` after `afterId`, then the later sources, are next. */
export type StoredMediaSizeCursor = Readonly<{ source: StoredMediaSizeSource; afterId: string }>;

/**
 * The next `limit` rows with an object of unknown size after `cursor`, in
 * source order, then id order. One read, so a run with nothing left to do
 * costs a single query.
 */
export type ListUnsizedMedia = (
  cursor: StoredMediaSizeCursor,
  limit: number,
) => Promise<Result<ReadonlyArray<UnsizedMedia>, RepositoryError>>;

/**
 * The byte size of the object stored at `objectKey`, from its metadata alone
 * (no body read); undefined when there is no such object. Rejects when the
 * bucket cannot answer.
 */
export type HeadStoredMedia = (objectKey: string) => Promise<number | undefined>;

/** A size the backfill read: `size` bytes are stored at `objectKey` for `slot`. */
export type StoredMediaSize = Readonly<{ slot: StoredMediaSlot; objectKey: string; size: number }>;

/**
 * Record the sizes read for a row, each only while the row still holds that
 * key and its size is still unknown: an upload or a metadata rewrite since
 * recorded the size of what it stored.
 */
export type RecordStoredMediaSizes = (
  media: UnsizedMedia,
  sizes: ReadonlyArray<StoredMediaSize>,
) => Promise<Result<void, RepositoryError>>;

/** An object the log should name: one missing from the bucket, or deferred. */
export type StoredMediaSizeReport = Readonly<{
  source: StoredMediaSizeSource;
  id: string;
  objectKey: string;
  outcome: Readonly<{ kind: "Missing" }> | Readonly<{ kind: "Deferred"; reason: string }>;
}>;

/**
 * One page of the backfill: what it did, the rows it went through, the
 * objects worth logging, and where the next page starts (undefined once the
 * last source is done).
 */
export type StoredMediaSizePass = Readonly<{
  scanned: number;
  tally: StoredMediaSizeTally;
  reports: ReadonlyArray<StoredMediaSizeReport>;
  next: StoredMediaSizeCursor | undefined;
}>;

/**
 * Fifty rows a page: each costs at most two HEADs (an attachment's original
 * and preview) and one D1 write, and the page one D1 read, so a page stays
 * near 150 subrequests, well within a queue invocation's 1,000 on the paid
 * plan; no body is read, so memory stays flat.
 */
const DEFAULT_ROWS = 50;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : "UnknownError";

type Looked =
  | Readonly<{ kind: "Sized"; size: StoredMediaSize }>
  | Readonly<{ kind: "Missing"; size: StoredMediaSize }>
  | Readonly<{ kind: "Deferred"; reason: string }>;

const lookUp = async (head: HeadStoredMedia, object: UnsizedObject): Promise<Looked> => {
  try {
    const size = await head(object.objectKey);
    return size === undefined
      ? { kind: "Missing", size: { ...object, size: 0 } }
      : { kind: "Sized", size: { ...object, size } };
  } catch (error) {
    return { kind: "Deferred", reason: reasonOf(error) };
  }
};

export const StoredMediaSizes = {
  sourceSchema: StoredMediaSizeSourceSchema,
  slotSchema: StoredMediaSlotSchema,
  tallySchema: StoredMediaSizeTallySchema,
  emptyTally: EMPTY_TALLY,
  sources: SOURCES,
  rows: DEFAULT_ROWS,

  /** Sum two tallies, counter by counter. */
  addTally: (a: StoredMediaSizeTally, b: StoredMediaSizeTally): StoredMediaSizeTally => ({
    sized: a.sized + b.sized,
    missing: a.missing + b.missing,
    deferred: a.deferred + b.deferred,
  }),

  /**
   * One page of the backfill from `cursor`: look up the size of each listed
   * row's objects of unknown size (HEAD, no body read) and record them; a
   * missing object is recorded as 0 bytes and reported. A row with a failed
   * lookup records nothing and is looked up again by a later run (the cron
   * starts over from the first row). A full page continues after its last
   * row; a short one ends the run.
   */
  pass: async (
    deps: Readonly<{
      list: ListUnsizedMedia;
      head: HeadStoredMedia;
      record: RecordStoredMediaSizes;
    }>,
    cursor: StoredMediaSizeCursor,
    rows: number = DEFAULT_ROWS,
  ): Promise<Result<StoredMediaSizePass, RepositoryError>> => {
    const listed = await deps.list(cursor, rows);
    if (listed.isErr()) {
      return err(listed.error);
    }
    const tally: Record<keyof StoredMediaSizeTally, number> = { ...EMPTY_TALLY };
    const reports: StoredMediaSizeReport[] = [];
    for (const media of listed.value) {
      const looked = await Promise.all(media.objects.map((object) => lookUp(deps.head, object)));
      const sizes: StoredMediaSize[] = [];
      for (const [index, result] of looked.entries()) {
        const objectKey = media.objects[index]?.objectKey ?? "";
        switch (result.kind) {
          case "Sized":
            tally.sized += 1;
            sizes.push(result.size);
            break;
          case "Missing":
            tally.missing += 1;
            sizes.push(result.size);
            reports.push({
              source: media.source,
              id: media.id,
              objectKey,
              outcome: { kind: "Missing" },
            });
            break;
          case "Deferred":
            tally.deferred += 1;
            reports.push({
              source: media.source,
              id: media.id,
              objectKey,
              outcome: { kind: "Deferred", reason: result.reason },
            });
            break;
        }
      }
      if (sizes.length < media.objects.length) {
        continue;
      }
      const recorded = await deps.record(media, sizes);
      if (recorded.isErr()) {
        reports.push({
          source: media.source,
          id: media.id,
          objectKey: media.objects[0]?.objectKey ?? "",
          outcome: { kind: "Deferred", reason: `RecordFailed: ${recorded.error.message}` },
        });
      }
    }
    const last = listed.value.at(-1);
    const next: StoredMediaSizeCursor | undefined =
      last !== undefined && listed.value.length >= rows
        ? { source: last.source, afterId: last.id }
        : undefined;
    return ok({ scanned: listed.value.length, tally, reports, next });
  },
} as const;
