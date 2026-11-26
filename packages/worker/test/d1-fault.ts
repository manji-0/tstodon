import { env } from "cloudflare:test";

/**
 * Every D1 statement that `fails` picks (by its SQL and bound values)
 * rejects as a D1 error while `run` runs, when it runs alone (`first`,
 * `all`, `raw`, `run`); other statements go through.
 */
export const failingStatements = async <T>(
  fails: (sql: string, params: ReadonlyArray<unknown>) => boolean,
  run: () => Promise<T>,
): Promise<T> => {
  const prototype: object = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const originals = new Map(
    ["first", "all", "raw", "run"].map((name) => [name, Reflect.get(prototype, name)]),
  );
  for (const [name, original] of originals) {
    Reflect.set(prototype, name, function (this: object, ...args: unknown[]) {
      const sql: unknown = Reflect.get(this, "statement");
      const params: unknown = Reflect.get(this, "params");
      if (typeof sql === "string" && Array.isArray(params) && fails(sql, params)) {
        return Promise.reject(new Error("D1_ERROR: injected"));
      }
      return Reflect.apply(original, this, args);
    });
  }
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) {
      Reflect.set(prototype, name, original);
    }
  }
};

/** {@link failingStatements} of `SELECT`s only. */
export const failingReads = <T>(
  fails: (sql: string, params: ReadonlyArray<unknown>) => boolean,
  run: () => Promise<T>,
): Promise<T> =>
  failingStatements((sql, params) => /^\s*SELECT\b/i.test(sql) && fails(sql, params), run);

/**
 * {@link failingReads} of `status_quotes`: those that bind a value containing
 * `id`, or every one when `id` is `undefined`.
 */
export const failingQuoteReads = <T>(id: string | undefined, run: () => Promise<T>): Promise<T> =>
  failingReads(
    (sql, params) =>
      sql.includes("status_quotes") &&
      (id === undefined || params.some((param) => typeof param === "string" && param.includes(id))),
    run,
  );

/**
 * Run `before` just before the first single D1 `run` whose SQL `matches`,
 * while `run` runs: another request acting between a read and the write
 * that relies on it.
 */
export const beforeStatement = async <T>(
  matches: (sql: string) => boolean,
  before: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> => {
  const prototype: object = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const original: unknown = Reflect.get(prototype, "run");
  if (typeof original !== "function") {
    throw new Error("D1 statements have no run");
  }
  let pending = true;
  Reflect.set(prototype, "run", async function (this: object, ...args: unknown[]) {
    const sql: unknown = Reflect.get(this, "statement");
    if (pending && typeof sql === "string" && matches(sql)) {
      pending = false;
      await before();
    }
    return Reflect.apply(original, this, args);
  });
  try {
    return await run();
  } finally {
    Reflect.set(prototype, "run", original);
  }
};

/**
 * Run `before` just before the first `env.DB` batch whose statements
 * `matches` picks, while `run` runs: what another request does between a
 * read and the batch that acts on it.
 */
export const beforeBatch = async <T>(
  matches: (sql: string) => boolean,
  before: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> => {
  const original = env.DB.batch;
  let pending = true;
  Reflect.set(env.DB, "batch", async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
    const picked = statements.some((statement) => {
      const sql: unknown = Reflect.get(statement, "statement");
      return typeof sql === "string" && matches(sql);
    });
    if (pending && picked) {
      pending = false;
      await before();
    }
    return original.call(env.DB, statements);
  });
  try {
    return await run();
  } finally {
    Reflect.set(env.DB, "batch", original);
  }
};
