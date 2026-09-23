/** Convert Prisma TypedSQL ($1-style) into a D1 prepared statement (?-style). */
export const d1PrepareTyped = (
  db: D1Database,
  typed: { readonly sql: string; readonly values: ReadonlyArray<unknown> },
): D1PreparedStatement =>
  db.prepare(typed.sql.replace(/\$\d+/g, "?")).bind(...(typed.values as unknown[]));

/** Run a TypedSQL SELECT / RETURNING query through D1. */
export const queryTyped = async <Row = Record<string, unknown>>(
  db: D1Database,
  typed: { readonly sql: string; readonly values: ReadonlyArray<unknown> },
): Promise<Row[]> => {
  const { results } = await d1PrepareTyped(db, typed).all<Row>();
  return (results ?? []) as Row[];
};

/** Run a TypedSQL write through D1 (no result rows required). */
export const runTyped = async (
  db: D1Database,
  typed: { readonly sql: string; readonly values: ReadonlyArray<unknown> },
): Promise<D1Result> => d1PrepareTyped(db, typed).run();
