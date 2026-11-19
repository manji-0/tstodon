import { env } from "cloudflare:test";

/**
 * Every D1 `SELECT` that `fails` picks (by its SQL and bound values) rejects
 * as a D1 error while `run` runs; other statements go through.
 */
export const failingReads = async <T>(
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
      if (
        typeof sql === "string" &&
        /^\s*SELECT\b/i.test(sql) &&
        Array.isArray(params) &&
        fails(sql, params)
      ) {
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
