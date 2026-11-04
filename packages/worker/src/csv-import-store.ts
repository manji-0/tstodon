import {
  ImportMode,
  type ImportModeValue,
  ImportRow,
  type ImportRowValue,
  ImportType,
  type ImportTypeValue,
  RowFailure,
  type RowFailureValue,
  type RowOutcomeValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import type { ParsedLine } from "./csv-import-file";
import {
  chunkArray,
  jsonStringArray,
  parseRows,
  type RepositoryError,
  runD1,
  sqlInJsonEach,
} from "./d1";
import { newEntityId } from "./ids";

/**
 * Imports kept per account, newest first; older finished ones are deleted
 * when a new one is made.
 */
export const IMPORTS_KEPT = 5;

/**
 * An import still `Queued` after this long lost its job; it stops blocking a
 * new import and is shown as `Failed`.
 */
export const IMPORT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Rows written per D1 batch while a file is stored. */
const STORE_CHUNK = 100;

/** Where an import is: running its job, done, or stopped because its job was lost. */
export type ImportState = "Queued" | "Finished" | "Failed";

/** Rows of an import by outcome. */
export type ImportCounts = Readonly<{
  pending: number;
  applied: number;
  failed: number;
}>;

export type CsvImport = Readonly<{
  id: string;
  type: ImportTypeValue;
  mode: ImportModeValue;
  state: ImportState;
  createdAt: string;
  counts: ImportCounts;
}>;

const ImportRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  mode: z.string(),
  state: z.union([z.literal("Queued"), z.literal("Finished"), z.literal("Failed")]),
  created_at: z.string(),
});

const OutcomeCountSchema = z.object({ outcome: z.string(), count: z.number() });

const countsFrom = (rows: ReadonlyArray<z.infer<typeof OutcomeCountSchema>>): ImportCounts => {
  const count = (outcome: string): number =>
    rows.find((row) => row.outcome === outcome)?.count ?? 0;
  return { pending: count("Pending"), applied: count("Applied"), failed: count("Failed") };
};

const storedRow = (line: ParsedLine): ReadonlyArray<string | number | null> =>
  line.kind === "Ready"
    ? [line.position, line.input, JSON.stringify(line.row), line.key, "Pending", null]
    : [line.position, line.input, null, "", "Failed", line.failure.kind];

/**
 * Store an import and its lines for `accountId`. `undefined` when the account
 * already has one that is `Queued`: one runs at a time. An import with no
 * line to apply is `Finished` at once.
 */
export const createCsvImport = async (
  db: D1Database,
  input: Readonly<{
    accountId: string;
    type: ImportTypeValue;
    mode: ImportModeValue;
    lines: ReadonlyArray<ParsedLine>;
  }>,
): Promise<Result<Readonly<{ id: string; state: ImportState }> | undefined, RepositoryError>> =>
  runD1(async () => {
    const id = newEntityId();
    const now = nowIso();
    const state: ImportState = input.lines.some((line) => line.kind === "Ready")
      ? "Queued"
      : "Finished";
    await db
      .prepare(
        `UPDATE csv_imports SET state = 'Failed', finished_at = ?
         WHERE account_id = ? AND state = 'Queued' AND created_at < ?`,
      )
      .bind(now, input.accountId, new Date(Date.now() - IMPORT_STALE_AFTER_MS).toISOString())
      .run();
    const inserted = await db
      .prepare(
        `INSERT INTO csv_imports (id, account_id, type, mode, state, created_at, finished_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE NOT EXISTS (
           SELECT 1 FROM csv_imports WHERE account_id = ?2 AND state = 'Queued'
         )`,
      )
      .bind(
        id,
        input.accountId,
        input.type.kind,
        input.mode.kind,
        state,
        now,
        state === "Finished" ? now : null,
      )
      .run();
    if (inserted.meta.changes === 0) {
      return undefined;
    }
    try {
      for (const chunk of chunkArray(input.lines, STORE_CHUNK)) {
        await db.batch(
          chunk.map((line) =>
            db
              .prepare(
                `INSERT INTO csv_import_rows (import_id, position, input, row_json, key, outcome, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(id, ...storedRow(line)),
          ),
        );
      }
    } catch (error) {
      // A half-stored import must not stay `Queued`: nothing would run it and it would block the next upload.
      await db.prepare("DELETE FROM csv_imports WHERE id = ?").bind(id).run();
      throw error;
    }
    await db
      .prepare(
        `DELETE FROM csv_imports
         WHERE account_id = ?1 AND state = 'Finished' AND id NOT IN (
           SELECT id FROM csv_imports WHERE account_id = ?1 ORDER BY id DESC LIMIT ?2
         )`,
      )
      .bind(input.accountId, IMPORTS_KEPT)
      .run();
    return { id, state };
  });

/** A `Queued` import older than {@link IMPORT_STALE_AFTER_MS} lost its job: it reads as `Failed`. */
const staleAsFailed = (row: z.infer<typeof ImportRowSchema>): ImportState =>
  row.state === "Queued" && Date.parse(row.created_at) < Date.now() - IMPORT_STALE_AFTER_MS
    ? "Failed"
    : row.state;

const withCounts = async (
  db: D1Database,
  rows: ReadonlyArray<z.infer<typeof ImportRowSchema>>,
): Promise<ReadonlyArray<CsvImport>> => {
  if (rows.length === 0) {
    return [];
  }
  const counted = await db
    .prepare(
      `SELECT import_id, outcome, COUNT(*) AS count FROM csv_import_rows
       WHERE import_id ${sqlInJsonEach()} GROUP BY import_id, outcome`,
    )
    .bind(jsonStringArray(rows.map((row) => row.id)))
    .all();
  const counts = parseRows(OutcomeCountSchema.extend({ import_id: z.string() }), counted.results);
  return rows.flatMap((row) => {
    const type = ImportType.parse({ kind: row.type });
    const mode = ImportMode.parse({ kind: row.mode });
    return type.isOk() && mode.isOk()
      ? [
          {
            id: row.id,
            type: type.value,
            mode: mode.value,
            state: staleAsFailed(row),
            createdAt: row.created_at,
            counts: countsFrom(counts.filter((count) => count.import_id === row.id)),
          },
        ]
      : [];
  });
};

/** The account's imports, newest first. */
export const listCsvImports = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReadonlyArray<CsvImport>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT id, type, mode, state, created_at FROM csv_imports
         WHERE account_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .bind(accountId, IMPORTS_KEPT)
      .all();
    return withCounts(db, parseRows(ImportRowSchema, rows.results));
  });

/** One of the account's imports; another account's import is `undefined`. */
export const findCsvImport = async (
  db: D1Database,
  accountId: string,
  importId: string,
): Promise<Result<CsvImport | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT id, type, mode, state, created_at FROM csv_imports
         WHERE id = ? AND account_id = ?`,
      )
      .bind(importId, accountId)
      .all();
    return (await withCounts(db, parseRows(ImportRowSchema, rows.results)))[0];
  });

/** The import and the account it belongs to, for the queue job (which has the id alone). */
export const findCsvImportOwner = async (
  db: D1Database,
  importId: string,
): Promise<
  Result<
    Readonly<{ accountId: string; type: ImportTypeValue; mode: ImportModeValue }> | undefined,
    RepositoryError
  >
> =>
  runD1(async () => {
    const rows = await db
      .prepare("SELECT account_id, type, mode FROM csv_imports WHERE id = ? AND state = 'Queued'")
      .bind(importId)
      .all();
    const row = parseRows(
      z.object({ account_id: z.string(), type: z.string(), mode: z.string() }),
      rows.results,
    )[0];
    const type = ImportType.parse({ kind: row?.type });
    const mode = ImportMode.parse({ kind: row?.mode });
    return row && type.isOk() && mode.isOk()
      ? { accountId: row.account_id, type: type.value, mode: mode.value }
      : undefined;
  });

export type PendingRow = Readonly<{ position: number; row: ImportRowValue }>;

/** Up to `limit` pending rows of the import after `afterPosition`, in file order. */
export const listPendingRows = async (
  db: D1Database,
  importId: string,
  afterPosition: number,
  limit: number,
): Promise<Result<ReadonlyArray<PendingRow>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT position, row_json FROM csv_import_rows
         WHERE import_id = ? AND position > ? AND outcome = 'Pending'
         ORDER BY position LIMIT ?`,
      )
      .bind(importId, afterPosition, limit)
      .all();
    return parseRows(
      z.object({ position: z.number(), row_json: z.string() }),
      rows.results,
    ).flatMap((row) => {
      const parsed = ImportRow.parse(safeJson(row.row_json));
      return parsed.isOk() ? [{ position: row.position, row: parsed.value }] : [];
    });
  });

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export type FailedRow = Readonly<{ position: number; input: string; failure: RowFailureValue }>;

/** The first `limit` failed rows of the import, in file order. */
export const listFailedRows = async (
  db: D1Database,
  importId: string,
  limit: number,
): Promise<Result<ReadonlyArray<FailedRow>, RepositoryError>> =>
  runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT position, input, reason FROM csv_import_rows
         WHERE import_id = ? AND outcome = 'Failed' ORDER BY position LIMIT ?`,
      )
      .bind(importId, limit)
      .all();
    return parseRows(
      z.object({ position: z.number(), input: z.string(), reason: z.string() }),
      rows.results,
    ).flatMap((row) => {
      const failure = RowFailure.parse({ kind: row.reason });
      return failure.isOk()
        ? [{ position: row.position, input: row.input, failure: failure.value }]
        : [];
    });
  });

/**
 * Record what happened to one row, and the account it resolved to when it
 * did (see `csv_import_rows.resolved`).
 */
export const recordRowOutcome = async (
  db: D1Database,
  importId: string,
  position: number,
  outcome: Exclude<RowOutcomeValue, { kind: "Pending" }>,
  resolved: string | undefined,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `UPDATE csv_import_rows SET outcome = ?, reason = ?, resolved = ?
         WHERE import_id = ? AND position = ?`,
      )
      .bind(
        outcome.kind,
        outcome.kind === "Failed" ? outcome.failure.kind : null,
        resolved ?? null,
        importId,
        position,
      )
      .run();
  });

/** Drop an import and its rows (its job could not be queued). */
export const deleteCsvImport = async (
  db: D1Database,
  importId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db.prepare("DELETE FROM csv_imports WHERE id = ?").bind(importId).run();
  });

export const finishCsvImport = async (
  db: D1Database,
  importId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare("UPDATE csv_imports SET state = 'Finished', finished_at = ? WHERE id = ?")
      .bind(nowIso(), importId)
      .run();
  });

/** Mark an import whose job the queue gave up on; one already finished stays so. */
export const failCsvImport = async (
  db: D1Database,
  importId: string,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        "UPDATE csv_imports SET state = 'Failed', finished_at = ? WHERE id = ? AND state = 'Queued'",
      )
      .bind(nowIso(), importId)
      .run();
  });

/** What a file row says about the entries it may name. */
export type NamingRow = Readonly<{ key: string; resolved: string | null }>;

/**
 * The rows of the import's file that may name one of `entries`: by the
 * account the row resolved to, or, for a row that resolved to none, by its
 * key (the handle text).
 */
export const rowsNaming = async (
  db: D1Database,
  importId: string,
  entries: ReadonlyArray<Readonly<{ key: string; resolved: string }>>,
): Promise<Result<ReadonlyArray<NamingRow>, RepositoryError>> => {
  if (entries.length === 0) {
    return ok([]);
  }
  return runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT DISTINCT key, resolved FROM csv_import_rows
         WHERE import_id = ? AND (
           (resolved IS NULL AND key ${sqlInJsonEach()}) OR resolved ${sqlInJsonEach()}
         )`,
      )
      .bind(
        importId,
        jsonStringArray(entries.map((entry) => entry.key)),
        jsonStringArray(entries.map((entry) => entry.resolved)),
      )
      .all();
    return parseRows(z.object({ key: z.string(), resolved: z.string().nullable() }), rows.results);
  });
};

/** The titles of the lists a lists import names. */
export const listTitlesInFile = async (
  db: D1Database,
  importId: string,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  const found = await runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT DISTINCT json_extract(row_json, '$.listTitle') AS title FROM csv_import_rows
         WHERE import_id = ? AND row_json IS NOT NULL`,
      )
      .bind(importId)
      .all();
    return parseRows(z.object({ title: z.string() }), rows.results).map((row) => row.title);
  });
  return found.isErr() ? err(found.error) : ok(new Set(found.value));
};
