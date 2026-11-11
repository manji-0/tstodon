import { parseRows, runD1Batch, runD1BatchChunked, type RepositoryError } from "./d1";
import type { Result } from "neverthrow";
import { z } from "zod";

export type TypedSqlLike = { readonly sql: string; readonly values: ReadonlyArray<unknown> };

/**
 * Convert Prisma TypedSQL ($1-style) into a D1 prepared statement (?-style).
 *
 * Prisma parameters are positional names ($1, $2, ...) and may be referenced
 * more than once. D1 placeholders are positional and each `?` needs its own
 * bound value, so expand one value per occurrence in the order they appear.
 */
export const d1PrepareTyped = (db: D1Database, typed: TypedSqlLike): D1PreparedStatement => {
  const values: unknown[] = [];
  const sql = typed.sql.replace(/\$(\d+)/g, (_match, index: string) => {
    values.push(typed.values[Number(index) - 1]);
    return "?";
  });
  return db.prepare(sql).bind(...values);
};

/** A row whose columns the caller does not read: it only counts or awaits the rows. */
export const CountedRow = z.object({});

/**
 * Run a TypedSQL SELECT / RETURNING query through D1 and parse its rows with
 * `schema`. Prisma's generated row types do not describe what D1 returns
 * (`COUNT(*)` is typed `bigint`; D1 yields a number), so rows are parsed here,
 * once. A row that does not match is left out, as {@link parseRows} does.
 */
export const queryTyped = async <Row>(
  db: D1Database,
  typed: TypedSqlLike,
  schema: z.ZodType<Row>,
): Promise<Row[]> => {
  const { results } = await d1PrepareTyped(db, typed).all();
  return parseRows(schema, results);
};

/** Run a TypedSQL write through D1 (no result rows required). */
export const runTyped = async (db: D1Database, typed: TypedSqlLike): Promise<D1Result> =>
  d1PrepareTyped(db, typed).run();

/** Run many TypedSQL statements in one D1 batch (transactional round-trip). */
export const runTypedBatch = (
  db: D1Database,
  statements: ReadonlyArray<TypedSqlLike>,
): Promise<Result<D1Result[], RepositoryError>> =>
  runD1Batch(
    db,
    statements.map((typed) => d1PrepareTyped(db, typed)),
  );

/** Chunked variant of {@link runTypedBatch} for large homogeneous write sets. */
export const runTypedBatchChunked = (
  db: D1Database,
  statements: ReadonlyArray<TypedSqlLike>,
  chunkSize?: number,
): Promise<Result<D1Result[], RepositoryError>> =>
  runD1BatchChunked(
    db,
    statements.map((typed) => d1PrepareTyped(db, typed)),
    chunkSize,
  );
