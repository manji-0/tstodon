import { runD1Batch, runD1BatchChunked, type RepositoryError } from "./d1";
import type { Result } from "neverthrow";

type TypedSqlLike = { readonly sql: string; readonly values: ReadonlyArray<unknown> };

/** Convert Prisma TypedSQL ($1-style) into a D1 prepared statement (?-style). */
export const d1PrepareTyped = (db: D1Database, typed: TypedSqlLike): D1PreparedStatement =>
  db.prepare(typed.sql.replace(/\$\d+/g, "?")).bind(...(typed.values as unknown[]));

/** Run a TypedSQL SELECT / RETURNING query through D1. */
export const queryTyped = async <Row = Record<string, unknown>>(
  db: D1Database,
  typed: TypedSqlLike,
): Promise<Row[]> => {
  const { results } = await d1PrepareTyped(db, typed).all<Row>();
  return (results ?? []) as Row[];
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
