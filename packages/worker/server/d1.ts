import { err, ok, type Result } from "neverthrow";
import { schemaResult } from "@tstodon/core";
import type { RepositoryError } from "@tstodon/domain";
import { type z } from "zod";

export const toRepositoryError = (message: string): RepositoryError => ({
  kind: "RepositoryError",
  message,
});

/**
 * A stored row that does not read as what its table holds; `id` is the row's.
 * Unlike a `RepositoryError`, reading it again gives the same answer, so a
 * sender gains nothing by delivering again. `fault` says what does not read:
 * the `Shape` of the row (a column that is empty or of another type, which
 * the row schema refuses), or its `Values` (a visibility that is none).
 */
export type StoredRowInvalid = Readonly<{
  kind: "StoredRowInvalid";
  id: string;
  fault: "Shape" | "Values";
}>;

/** The error of a reader that fails on a row it cannot use, whatever is wrong with it. */
export const storedRowError = (error: RepositoryError | StoredRowInvalid): RepositoryError =>
  error.kind === "RepositoryError" ? error : toRepositoryError("invalid stored row");

/**
 * The answer of a finder that does not tell a row that does not read from a
 * failed read. A row whose shape does not parse reads as none, as
 * {@link parseRows} leaves it out; one whose values do not read is an error.
 */
export const foundRow = <T>(
  read: Result<T | undefined, RepositoryError | StoredRowInvalid>,
): Result<T | undefined, RepositoryError> => {
  if (read.isOk()) {
    return ok(read.value);
  }
  return read.error.kind === "StoredRowInvalid" && read.error.fault === "Shape"
    ? ok(undefined)
    : err(storedRowError(read.error));
};

/**
 * The read of a caller that goes on without a row that does not read: the
 * row is logged and counts as none, where a failed read stays an error. An
 * inbox activity that refers to such a row is settled this way, as its
 * redelivery would find the same row.
 */
export const readableRow = <T>(
  read: Result<T | undefined, RepositoryError | StoredRowInvalid>,
): Result<T | undefined, RepositoryError> => {
  if (read.isOk()) {
    return ok(read.value);
  }
  if (read.error.kind === "RepositoryError") {
    return err(read.error);
  }
  console.warn(
    JSON.stringify({
      kind: "InvalidStoredRowSkipped",
      rowId: read.error.id,
      fault: read.error.fault,
    }),
  );
  return ok(undefined);
};

export const parseRow = <T>(schema: z.ZodType<T>, value: unknown): Result<T, RepositoryError> =>
  schemaResult(schema)(value).mapErr(() => toRepositoryError("invalid row"));

/**
 * Rows that match the schema, in order. A row that does not match (a column
 * renamed under the code, a corrupt value) is left out rather than trusted.
 */
export const parseRows = <T>(schema: z.ZodType<T>, rows: ReadonlyArray<unknown> | undefined): T[] =>
  (rows ?? []).flatMap((row) => {
    const parsed = schemaResult(schema)(row);
    return parsed.isOk() ? [parsed.value] : [];
  });

/** The values of the results that succeeded, in order; a failed one is left out. */
export const okValues = <T, E>(results: Iterable<Result<T, E>>): T[] =>
  [...results].flatMap((result) => (result.isOk() ? [result.value] : []));

/** The failure every D1 adapter maps its errors to; the domain's contracts name it. */
export type { RepositoryError };

/** Soft cap for `db.batch` size — stay clear of statement/parameter platform limits. */
export const D1_BATCH_CHUNK_SIZE = 100;

/**
 * Cloudflare D1 (SQLite) rejects statements with more than 100 bound parameters.
 * Prefer {@link sqlInJsonEach} for variable-length membership so bind count stays O(1)
 * (same lesson as cfwdon: growing `IN (?,?,…)` lists 500 when N > 100).
 */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * SQL fragment `IN (SELECT value FROM json_each(?))` — one bind for any list size.
 * Bind {@link jsonStringArray} as that single parameter.
 */
export const sqlInJsonEach = (): string => "IN (SELECT value FROM json_each(?))";

/** JSON text array payload for {@link sqlInJsonEach}. */
export const jsonStringArray = (values: ReadonlyArray<string>): string =>
  JSON.stringify([...values]);

export const chunkArray = <T>(
  items: ReadonlyArray<T>,
  chunkSize: number = D1_BATCH_CHUNK_SIZE,
): T[][] => {
  if (items.length === 0) {
    return [];
  }
  const size = Math.max(1, chunkSize);
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
};

export const runD1 = async <T>(work: () => Promise<T>): Promise<Result<T, RepositoryError>> => {
  try {
    return ok(await work());
  } catch (cause) {
    return err({
      kind: "RepositoryError",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
};

/**
 * Run multiple prepared statements in one D1 round-trip / SQL transaction.
 * Prefer this over sequential `await stmt.run()` loops and over `Promise.all` of writes.
 */
export const runD1Batch = (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>,
): Promise<Result<D1Result[], RepositoryError>> => {
  if (statements.length === 0) {
    return Promise.resolve(ok([]));
  }
  return runD1(() => db.batch([...statements]));
};

/** Split a large statement list into chunks and run each via `runD1Batch`. */
export const runD1BatchChunked = async (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>,
  chunkSize: number = D1_BATCH_CHUNK_SIZE,
): Promise<Result<D1Result[], RepositoryError>> => {
  if (statements.length === 0) {
    return ok([]);
  }
  const size = Math.max(1, chunkSize);
  const out: D1Result[] = [];
  for (let offset = 0; offset < statements.length; offset += size) {
    const chunk = statements.slice(offset, offset + size);
    const batched = await runD1Batch(db, chunk);
    if (batched.isErr()) {
      return err(batched.error);
    }
    out.push(...batched.value);
  }
  return ok(out);
};
