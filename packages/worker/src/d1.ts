import { err, ok, type Result } from "neverthrow";

export type RepositoryError = Readonly<{
  kind: "RepositoryError";
  message: string;
}>;

/** Soft cap for `db.batch` size — stay clear of statement/parameter platform limits. */
export const D1_BATCH_CHUNK_SIZE = 100;

/** Soft cap for `IN (...)` bind lists (platform max bound params is 100). */
export const D1_IN_CHUNK_SIZE = 50;

export const chunkArray = <T>(
  items: ReadonlyArray<T>,
  chunkSize: number = D1_IN_CHUNK_SIZE,
): T[][] => {
  if (items.length === 0) {
    return [];
  }
  const size = Math.max(1, chunkSize);
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
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
