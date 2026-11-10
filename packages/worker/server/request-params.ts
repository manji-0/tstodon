import type { Context } from "hono";
import { schemaResult } from "@tstodon/core";
import { type Result, err } from "neverthrow";
import { z } from "zod";
import { isTruthy } from "./form-values";
import { nestFormKeys, readUnknownBody } from "./http";

/**
 * Request params read with the shared schemas in `@tstodon/api` (`params/`).
 *
 * Those schemas describe what a JSON client sends: booleans, numbers and
 * arrays. Mastodon clients also send forms and query strings, where every
 * value is a string and an array is `key[]=a&key[]=b` (or a repeated key), so
 * the Worker brings a request to the JSON shape before parsing, the way
 * Rails' params casting does in Mastodon:
 *
 * 1. `key[]` folds into `key` (bracketed values first), and a body's
 *    `a[b][c]` keys nest into objects (`nestFormKeys`);
 * 2. each field is cast to the type its schema declares: a boolean from
 *    `true` / `1` (anything else is `false`, as `isTruthy` always read
 *    them), a number with `parseInt` (one that does not parse is left out,
 *    so the endpoint's default applies), and an array from a single value
 *    (an empty string is an empty array) or from an object keyed by
 *    position (`key[0][a]`, Rails' nested attributes). In a query string, a repeated
 *    key of a field that is not an array keeps its first value.
 *
 * A JSON body is cast the same way, so `"true"` in JSON keeps working. What
 * the schema does not describe (strings, unions, literals) is passed through
 * for it to check.
 */

type ParamsError = { kind: "ValidationError" };

type Source = "body" | "query";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Blob) &&
  !(value instanceof File);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** `key[]` folded into `key`: bracketed values first, then the plain key's. */
export const foldArrayKeys = (raw: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const folded: Record<string, unknown> = {};
  const entries = Object.entries(raw);
  for (const [key, value] of entries) {
    if (key.endsWith("[]") && key.length > 2) {
      const name = key.slice(0, -2);
      const existing = folded[name];
      folded[name] = [...(existing === undefined ? [] : asList(existing)), ...asList(value)];
    }
  }
  for (const [key, value] of entries) {
    if (key.endsWith("[]") && key.length > 2) {
      continue;
    }
    const existing = folded[key];
    folded[key] = existing === undefined ? value : [...asList(existing), ...asList(value)];
  }
  return folded;
};

/** The schema under `optional` / `nullable` / `default` wrappers. */
const unwrapped = (schema: z.core.$ZodType): z.core.$ZodType =>
  schema instanceof z.ZodOptional ||
  schema instanceof z.ZodNullable ||
  schema instanceof z.ZodDefault
    ? unwrapped(schema.unwrap())
    : schema;

/**
 * A form's `key[0][a]=…&key[1][a]=…` nests into an object keyed by position;
 * as Rails' nested attributes do, an array field reads its values in order.
 */
const indexedValues = (value: unknown): unknown[] | undefined => {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => /^\d+$/.test(key))) {
    return undefined;
  }
  return keys.toSorted((left, right) => Number(left) - Number(right)).map((key) => value[key]);
};

/** Marks a value the cast leaves out (a number that does not parse). */
const OMIT = Symbol("omit");

const castValue = (schema: z.core.$ZodType, value: unknown, source: Source): unknown => {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodArray) {
    const items = Array.isArray(value)
      ? value
      : value === "" || value === undefined
        ? []
        : (indexedValues(value) ?? [value]);
    return items.flatMap((item) => {
      const cast = castValue(inner.element, item, source);
      return cast === OMIT ? [] : [cast];
    });
  }
  // A repeated query key of a single-valued field keeps its first value.
  const single: unknown = source === "query" && Array.isArray(value) ? value.at(0) : value;
  if (inner instanceof z.ZodBoolean) {
    return typeof single === "string" || typeof single === "number" ? isTruthy(single) : single;
  }
  if (inner instanceof z.ZodNumber) {
    if (typeof single !== "string") {
      return single;
    }
    const parsed = Number.parseInt(single, 10);
    return Number.isFinite(parsed) ? parsed : OMIT;
  }
  if (inner instanceof z.ZodObject) {
    return isPlainRecord(single) ? castFields(inner, single, source) : single;
  }
  return single;
};

const castFields = (
  schema: z.ZodObject,
  raw: Readonly<Record<string, unknown>>,
  source: Source,
): Record<string, unknown> => {
  const shape: Readonly<Record<string, z.core.$ZodType>> = schema.shape;
  const cast: Record<string, unknown> = { ...raw };
  for (const [key, field] of Object.entries(shape)) {
    if (!(key in raw) || raw[key] === undefined) {
      continue;
    }
    const value = castValue(field, raw[key], source);
    if (value === OMIT) {
      delete cast[key];
    } else {
      cast[key] = value;
    }
  }
  return cast;
};

/** A decoded form, query or JSON record brought to the schema's JSON shape. */
export const castParams = (
  schema: z.core.$ZodType,
  raw: Readonly<Record<string, unknown>>,
  source: Source,
): Record<string, unknown> => {
  const inner = unwrapped(schema);
  return inner instanceof z.ZodObject ? castFields(inner, raw, source) : { ...raw };
};

const validationError = (): ParamsError => ({ kind: "ValidationError" });

/** Parse a decoded body (JSON, or a form record) with a shared params schema. */
export const parseBodyParams = <T>(schema: z.ZodType<T>, raw: unknown): Result<T, ParamsError> =>
  schemaResult(schema)(
    isPlainRecord(raw) ? castParams(schema, nestFormKeys(foldArrayKeys(raw)), "body") : raw,
  ).mapErr(validationError);

/** The query string as a record: a repeated or `[]` key is a list. */
const queryRecord = (c: Context<{ Bindings: Env }>): Record<string, unknown> => {
  const values = new Map<string, string[]>();
  for (const [key, value] of new URL(c.req.url).searchParams) {
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return foldArrayKeys(
    Object.fromEntries(
      [...values].map(([key, list]) => [
        key,
        list.length === 1 && !key.endsWith("[]") ? list[0] : list,
      ]),
    ),
  );
};

/** The query string, parsed with a shared params schema. */
export const readQueryParams = <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Result<T, ParamsError> =>
  schemaResult(schema)(castParams(schema, queryRecord(c), "query")).mapErr(validationError);

/** The body (JSON or form), parsed with a shared params schema. */
export const readParams = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, ParamsError>> => parseBodyParams(schema, await readUnknownBody(c));

/** The body, or `{}` when there is none (or it does not decode). */
const optionalBody = async (c: Context<{ Bindings: Env }>): Promise<unknown> => {
  try {
    return await readUnknownBody(c);
  } catch {
    return {};
  }
};

/** {@link readParams} for endpoints that are also valid without a body. */
export const readOptionalParams = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, ParamsError>> => parseBodyParams(schema, await optionalBody(c));

/**
 * Query and body together, as Rails' `params` merges them: a field in the
 * body wins over the same field in the query. For endpoints whose clients
 * send params either way (the web UI sends a `DELETE`'s in the query).
 */
export const readMergedParams = async <T>(
  c: Context<{ Bindings: Env }>,
  schema: z.ZodType<T>,
): Promise<Result<T, ParamsError>> => {
  const body = await optionalBody(c);
  if (!isPlainRecord(body)) {
    return err(validationError());
  }
  const query = castParams(schema, queryRecord(c), "query");
  const fromBody = castParams(schema, nestFormKeys(foldArrayKeys(body)), "body");
  return schemaResult(schema)({ ...query, ...fromBody }).mapErr(validationError);
};

/** The paging cursor of a parsed params object, as `queryCursor` reads it. */
export const paramsCursor = (
  params: Readonly<{
    max_id?: string | undefined;
    since_id?: string | undefined;
    min_id?: string | undefined;
  }>,
): Readonly<{
  maxId?: string | undefined;
  sinceId?: string | undefined;
  minId?: string | undefined;
}> => ({
  maxId: params.max_id,
  sinceId: params.since_id,
  minId: params.min_id,
});
