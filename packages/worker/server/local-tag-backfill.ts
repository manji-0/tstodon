import { extractHashtags } from "@tstodon/core";
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
import { indexLocalStatusTags, recordTagNames, searchableTagNames } from "./hashtags";
import { d1PrepareTyped, queryTyped } from "./typed-sql";

/**
 * The `backfill_cursors` row migration 0132 seeds for this job. Migration
 * 0108's `local_note_tags` row is left as it is: it is complete on a running
 * instance, where the notes still need their `local_status_tags` rows.
 */
const CURSOR = "local_status_tags";

/** Notes read per page: their text is short, and a page is two statements. */
export const LOCAL_TAG_BACKFILL_PAGE = 200;

const CursorRow = z.object({ after_id: z.string(), completed_at: z.string().nullable() });
const NoteTextRow = z.object({
  id: z.string(),
  account_id: z.string(),
  content_text: z.string(),
  visibility: z.string(),
});

/** One page of the backfill: how many notes it read, and whether another page follows. */
export type LocalTagBackfillPage = Readonly<{ scanned: number; chained: boolean }>;

/**
 * Index the next page of local notes written before `local_status_tags` (or
 * by the old worker during the deploy) under their tags, store the tag names
 * of the public and unlisted ones, and move the cursor past them. A short
 * page marks the cursor complete, after which every run reads the cursor and
 * stops. Two runs on one page write the same rows; only one moves the cursor
 * and chains.
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
  const tagged = notes.map((note) => ({ note, tags: extractHashtags(note.content_text) }));
  const names = new Set(
    tagged.flatMap(({ note, tags }) =>
      searchableTagNames(
        // An unreadable visibility keeps the names out, as a direct note's.
        Visibility.fromMastodon(note.visibility).unwrapOr(Visibility.Direct),
        tags,
      ),
    ),
  );
  const full = notes.length === pageSize;
  const advanced = await runD1Batch(db, [
    ...recordTagNames(db, [...names]),
    ...tagged.flatMap(({ note, tags }) =>
      indexLocalStatusTags(db, { id: note.id, accountId: note.account_id }, tags),
    ),
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
