import type { Result } from "neverthrow";
import { z } from "zod";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { htmlToText } from "./html";

/**
 * The statements that write a remote note's search document, run in the
 * batch that writes the note: its content as plain text, which the index's
 * triggers cannot compute from HTML. The insert is ignored when another note
 * holds the integer id.
 */
export const remoteSearchDocumentStatements = (
  db: D1Database,
  status: Readonly<{ id: string; contentHtml: string }>,
): D1PreparedStatement[] => {
  const text = htmlToText(status.contentHtml);
  return [
    db
      .prepare("UPDATE status_search_documents SET content_text = ? WHERE remote_status_id = ?")
      .bind(text, status.id),
    db
      .prepare(
        `INSERT OR IGNORE INTO status_search_documents (id, remote_status_id, content_text)
         SELECT CAST(id AS INTEGER), id, ? FROM remote_statuses WHERE id = ?`,
      )
      .bind(text, status.id),
  ];
};

const RemoteContentRow = z.object({
  id: z.string(),
  content_html: z.string(),
  indexed: z.number(),
});

/** Remote notes the backfill reads a page at a time. */
export const STATUS_SEARCH_BACKFILL_PAGE = 100;

/** The cursor of a finished backfill: it sorts after every status id. */
const BACKFILL_DONE = "~";

/**
 * Index a page of the remote notes cached before the index existed, walking
 * `remote_statuses` by id from the `status_search` cursor. A note indexed
 * since (by its write) is left as it is. A short page ends the walk: notes
 * stored after it are indexed by their writes. `chained` when the page was
 * full.
 */
export const backfillRemoteSearchDocuments = async (
  db: D1Database,
  pageSize: number = STATUS_SEARCH_BACKFILL_PAGE,
): Promise<Result<Readonly<{ scanned: number; chained: boolean }>, RepositoryError>> =>
  runD1(async () => {
    const cursor = z
      .object({ after_id: z.string() })
      .safeParse(
        await db
          .prepare("SELECT after_id FROM backfill_cursors WHERE name = 'status_search'")
          .first(),
      );
    if (!cursor.success || cursor.data.after_id === BACKFILL_DONE) {
      return { scanned: 0, chained: false };
    }
    const { results } = await db
      .prepare(
        `SELECT r.id, r.content_html, EXISTS (
           SELECT 1 FROM status_search_documents d WHERE d.remote_status_id = r.id
         ) AS indexed
         FROM remote_statuses r WHERE r.id > ? ORDER BY r.id LIMIT ?`,
      )
      .bind(cursor.data.after_id, pageSize)
      .all();
    const rows = parseRows(RemoteContentRow, results);
    const chained = rows.length === pageSize;
    await db.batch([
      ...rows
        .filter((row) => row.indexed === 0)
        .flatMap((row) =>
          remoteSearchDocumentStatements(db, { id: row.id, contentHtml: row.content_html }),
        ),
      db
        .prepare(
          "UPDATE backfill_cursors SET after_id = ? WHERE name = 'status_search' AND after_id = ?",
        )
        .bind(chained ? (rows.at(-1)?.id ?? BACKFILL_DONE) : BACKFILL_DONE, cursor.data.after_id),
    ]);
    return { scanned: rows.length, chained };
  });
