import { z } from "zod";

/** `REST::AsyncRefreshSerializer`. */
export const ApiAsyncRefresh = z.object({
  async_refresh: z.object({
    id: z.string(),
    status: z.literal(["running", "finished"]),
    result_count: z.number(),
  }),
});
export type ApiAsyncRefreshJSON = z.infer<typeof ApiAsyncRefresh>;

/** The error tokens of a `422` validation error's `details`. */
export const ERROR_TOKENS = [
  "ERR_TAKEN",
  "ERR_INVALID",
  "ERR_BLOCKED",
  "ERR_RESERVED",
  "ERR_TOO_MANY",
  "ERR_MALFORMED",
  "ERR_UNUSABLE",
  "ERR_TOO_SOON",
  "ERR_BELOW_LIMIT",
  "ERR_UNREACHABLE",
  "ERR_ELEVATED",
] as const;
export type ErrorToken = (typeof ERROR_TOKENS)[number];

export const ApiValidationError = z.object({
  error: z.literal(ERROR_TOKENS),
  description: z.string(),
});
export type ValidationError = z.infer<typeof ApiValidationError>;

/** Mastodon's `Error`: `error`, and `details` on a validation failure. */
export const ApiError = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  details: z.record(z.string(), z.array(ApiValidationError)).optional(),
});
export type ApiErrorJSON = z.infer<typeof ApiError>;
