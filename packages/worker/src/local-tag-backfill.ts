import { Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, runD1Batch, type RepositoryError } from "./d1";
import {
  advanceBackfillCursor as advanceBackfillCursorSql,
  listLocalNoteTextsAfter as listLocalNoteTextsAfterSql,
  readBackfillCursor as readBackfillCursorSql,
} from "./generated/prisma/sql";
import { extractHashtags, recordTagNames, searchableTagNames } from "./hashtags";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

/** The `backfill_cursors` row migration 0108 seeds for this job. */
const CURSOR = "local_note_tags";

/** Notes read per page: their text is short, and a page is two statements. */
export const LOCAL_TAG_BACKFILL_PAGE = 200;

const CursorRow = z.object({ after_id: z.string(), completed_at: z.string().nullable() });
const NoteTextRow = z.object({
  id: z.string(),
  content_text: z.string(),
  visibility: z.string(),
});

/** One page of the backfill: how many notes it read, and whether another page follows. */
export type LocalTagBackfillPage = Readonly<{ scanned: number; chained: boolean }>;

/**
 * Store the tag names of the next page of local notes written before the
 * `tags` table (or by the old worker during the deploy), public and unlisted
 * ones only, and move the cursor past them. A short page marks the cursor
 * complete, after which every run reads the cursor and stops. Two runs on one
 * page store the same names; only one moves the cursor and chains.
 */
export const backfillLocalNoteTags = async (
  db: D1Database,
  pageSize: number = LOCAL_TAG_BACKFILL_PAGE,
): Promise<Result<LocalTagBackfillPage, RepositoryError>> => {
  const read = await runD1(async () => {
    const cursor = (await queryTyped(db, readBackfillCursorSql(CURSOR), CursorRow))[0];
    if (cursor === undefined || cursor.completed_at !== null) {
      return undefined;
    }
    const notes = await queryTyped(
      db,
      listLocalNoteTextsAfterSql(cursor.after_id, pageSize),
      NoteTextRow,
    );
    return { afterId: cursor.after_id, notes };
  });
  if (read.isErr()) {
    return err(read.error);
  }
  if (read.value === undefined) {
    return ok({ scanned: 0, chained: false });
  }
  const { afterId, notes } = read.value;
  const names = new Set(
    notes.flatMap((note) =>
      searchableTagNames(
        // An unreadable visibility keeps the names out, as a direct note's.
        Visibility.fromMastodon(note.visibility).unwrapOr(Visibility.Direct),
        extractHashtags(note.content_text),
      ),
    ),
  );
  const full = notes.length === pageSize;
  const advanced = await runD1Batch(db, [
    ...recordTagNames(db, [...names]),
    d1PrepareTyped(
      db,
      advanceBackfillCursorSql(
        CURSOR,
        afterId,
        notes.at(-1)?.id ?? afterId,
        full ? null : nowIso(),
      ),
    ),
  ]);
  if (advanced.isErr()) {
    return err(advanced.error);
  }
  const moved = (advanced.value.at(-1)?.results ?? []).length > 0;
  return ok({ scanned: notes.length, chained: moved && full });
};
