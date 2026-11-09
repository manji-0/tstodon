import {
  type AdminDimensionKey,
  type AdminMeasureKey,
  isAdminDimensionKey,
  isAdminMeasureKey,
  isAdminRetentionFrequency,
} from "@tstodon/api/values";
import type { Context } from "hono";
import {
  adminDimensions,
  adminMeasures,
  adminRetention,
  type MeasureParams,
  type MetricsRange,
  parseMetricsRange,
} from "../../admin-metrics";
import { jsonAuthError, jsonRepositoryError, readUnknownBody, requireAdmin } from "../../http";
import { parseInstanceIdentity } from "../../runtime-config";
import { parseBool, validation } from "./shared";

/**
 * `POST /api/v1/admin/measures`, `/dimensions` and `/retention` (Mastodon's
 * dashboard API). Parameters come as JSON or a form body, or in the query
 * string: `keys[]`, `start_at`, `end_at`, a dimension `limit`, a retention
 * `frequency`, and per key `tag_*[id]` / `instance_*[domain]` (with
 * `include_subdomains`). Unknown keys are left out of the answer, as
 * Mastodon does.
 */

type Params = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The body (JSON or form) over the query string. */
const readParams = async (c: Context<{ Bindings: Env }>): Promise<Params> => {
  const query: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    query[key] = key.endsWith("[]") || values.length > 1 ? values : values[0];
  }
  let body: unknown = {};
  try {
    body = await readUnknownBody(c);
  } catch {
    body = {};
  }
  return { ...query, ...(isRecord(body) ? body : {}) };
};

const strings = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (isRecord(value)) {
    return Object.values(value).filter((entry): entry is string => typeof entry === "string");
  }
  return [];
};

const text = (value: unknown): string | undefined => {
  const [first] = strings(value);
  return first?.trim() || undefined;
};

/** `keys[]` (or `keys`), as given. */
const requestedKeys = (params: Params): string[] => [
  ...new Set([...strings(params["keys"]), ...strings(params["keys[]"])]),
];

/** `<key>[<field>]`, nested (JSON) or flat (form). */
const nested = (params: Params, key: string, field: string): string | undefined => {
  const group = params[key];
  return isRecord(group) ? text(group[field]) : text(params[`${key}[${field}]`]);
};

const keyParams = (params: Params, key: string): MeasureParams => ({
  tag: nested(params, key, "id"),
  domain: nested(params, key, "domain"),
  includeSubdomains: parseBool(
    nested(params, key, "include_subdomains") ?? params["include_subdomains"],
    false,
  ),
});

const rangeOf = (params: Params) =>
  parseMetricsRange(text(params["start_at"]), text(params["end_at"]));

/** The admin and the instance domain, or the response refusing the request. */
const prelude = async (
  c: Context<{ Bindings: Env }>,
): Promise<Readonly<{ domain: string; params: Params; range: MetricsRange }> | Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const params = await readParams(c);
  const range = rangeOf(params);
  if (range.isErr()) {
    return validation(c, range.error.message);
  }
  return { domain: identity.value.domain, params, range: range.value };
};

export const postV1AdminMeasures = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/measures">,
) => {
  const ready = await prelude(c);
  if (ready instanceof Response) {
    return ready;
  }
  const requests = requestedKeys(ready.params)
    .filter((key): key is AdminMeasureKey => isAdminMeasureKey(key))
    .map((key) => ({ key, params: keyParams(ready.params, key) }));
  const measures = await adminMeasures(c.env.DB, requests, ready.range, ready.domain);
  return measures.isErr() ? jsonRepositoryError(c, measures.error.message) : c.json(measures.value);
};

/** Dimension entries: 10 by default, at most 100. */
const dimensionLimit = (raw: string | undefined): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 10;
};

export const postV1AdminDimensions = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/dimensions">,
) => {
  const ready = await prelude(c);
  if (ready instanceof Response) {
    return ready;
  }
  const requests = requestedKeys(ready.params)
    .filter((key): key is AdminDimensionKey => isAdminDimensionKey(key))
    .map((key) => ({ key, params: keyParams(ready.params, key) }));
  const dimensions = await adminDimensions(
    c.env.DB,
    requests,
    ready.range,
    dimensionLimit(text(ready.params["limit"])),
    ready.domain,
  );
  return dimensions.isErr()
    ? jsonRepositoryError(c, dimensions.error.message)
    : c.json(dimensions.value);
};

export const postV1AdminRetention = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/retention">,
) => {
  const ready = await prelude(c);
  if (ready instanceof Response) {
    return ready;
  }
  const frequency = text(ready.params["frequency"]) ?? "day";
  if (!isAdminRetentionFrequency(frequency)) {
    return validation(c, "frequency must be day or month");
  }
  const cohorts = await adminRetention(c.env.DB, ready.range, frequency);
  return cohorts.isErr() ? jsonRepositoryError(c, cohorts.error.message) : c.json(cohorts.value);
};
