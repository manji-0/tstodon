import type { z } from "zod";

const REDACTED = "[REDACTED]";

/**
 * PII or key material. The value lives only in a closure, so `JSON.stringify`,
 * string coercion, `console.log` (Node's and workerd's, which both honor
 * `util.inspect.custom`) and reflection over the object print `[REDACTED]` or
 * nothing at all. `reveal()` is the one way out; every caller outside tests is
 * listed in `sensitive-reveal-sites.test.ts`.
 */
export type Sensitive<T> = Readonly<{
  reveal: () => T;
  toJSON: () => string;
  toString: () => string;
}>;

export const Sensitive = {
  of: <T>(value: T): Sensitive<T> =>
    Object.freeze({
      reveal: () => value,
      toJSON: () => REDACTED,
      toString: () => REDACTED,
      [Symbol.for("nodejs.util.inspect.custom")]: () => REDACTED,
    }),
  /** `schema`, with its output wrapped: what the schema reads never leaves it unwrapped. */
  schema: <S extends z.ZodType>(schema: S) =>
    schema.transform((value): Sensitive<z.output<S>> => Sensitive.of(value)),
} as const;
