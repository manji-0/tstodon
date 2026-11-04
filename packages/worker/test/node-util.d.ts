/**
 * The part of workerd's `node:util` (with `nodejs_compat`) the redaction test
 * calls: the formatter workerd's `console.log` also prints with.
 */
declare module "node:util" {
  export const inspect: (value: unknown, options?: Readonly<{ depth?: number }>) => string;
  export const format: (...values: ReadonlyArray<unknown>) => string;
}
