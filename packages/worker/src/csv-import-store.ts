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
 * An import still `Queued` after this long lost its job (the queue gave up
 * on it); it stops blocking a new import and is shown as finished.
 */
export const IMPORT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Rows written per D1 batch while a file is stored. */
const STORE_CHUNK = 100;

/** Where an import is: running its job, or done. */
export type ImportState = "Queued" | "Finished";

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
  state: z.union([z.literal("Queued"), z.literal("Finished")]),
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
        `UPDATE csv_imports SET state = 'Finished', finished_at = ?
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
            state: row.state,
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

/** Record what happened to one row. */
export const recordRowOutcome = async (
  db: D1Database,
  importId: string,
  position: number,
  outcome: Exclude<RowOutcomeValue, { kind: "Pending" }>,
): Promise<Result<void, RepositoryError>> =>
  runD1(async () => {
    await db
      .prepare(
        `UPDATE csv_import_rows SET outcome = ?, reason = ?
         WHERE import_id = ? AND position = ?`,
      )
      .bind(
        outcome.kind,
        outcome.kind === "Failed" ? outcome.failure.kind : null,
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

/** Which of `keys` the import's file names. */
export const keysInFile = async (
  db: D1Database,
  importId: string,
  keys: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepositoryError>> => {
  if (keys.length === 0) {
    return ok(new Set());
  }
  const found = await runD1(async () => {
    const rows = await db
      .prepare(
        `SELECT DISTINCT key FROM csv_import_rows
         WHERE import_id = ? AND key ${sqlInJsonEach()}`,
      )
      .bind(importId, jsonStringArray(keys))
      .all();
    return parseRows(z.object({ key: z.string() }), rows.results).map((row) => row.key);
  });
  return found.isErr() ? err(found.error) : ok(new Set(found.value));
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
