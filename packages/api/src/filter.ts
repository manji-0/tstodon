import { z } from "zod";
import { FILTER_ACTIONS, FILTER_CONTEXTS } from "./values";

/** `REST::FilterKeywordSerializer`. */
export const ApiFilterKeyword = z.object({
  id: z.string(),
  keyword: z.string(),
  whole_word: z.boolean(),
});
export type ApiFilterKeywordJSON = z.infer<typeof ApiFilterKeyword>;

/** `REST::FilterStatusSerializer`. */
export const ApiFilterStatus = z.object({
  id: z.string(),
  status_id: z.string(),
});
export type ApiFilterStatusJSON = z.infer<typeof ApiFilterStatus>;

/**
 * `REST::FilterSerializer` (v2). `keywords` and `statuses` are left out where
 * Mastodon renders a filter inside a `FilterResult`.
 */
export const ApiFilter = z.object({
  id: z.string(),
  title: z.string(),
  context: z.array(z.literal(FILTER_CONTEXTS)),
  expires_at: z.string().nullable(),
  filter_action: z.literal(FILTER_ACTIONS),
  keywords: z.array(ApiFilterKeyword).optional(),
  statuses: z.array(ApiFilterStatus).optional(),
});
export type ApiFilterJSON = z.infer<typeof ApiFilter>;

/** `REST::FilterResultSerializer`: a status's `filtered[]` entry. */
export const ApiFilterResult = z.object({
  filter: ApiFilter,
  keyword_matches: z.array(z.string()).nullable(),
  status_matches: z.array(z.string()).nullable(),
});
export type ApiFilterResultJSON = z.infer<typeof ApiFilterResult>;

/** `REST::V1::FilterSerializer` (`/api/v1/filters`). */
export const ApiV1Filter = z.object({
  id: z.string(),
  phrase: z.string(),
  context: z.array(z.literal(FILTER_CONTEXTS)),
  whole_word: z.boolean(),
  expires_at: z.string().nullable(),
  irreversible: z.boolean(),
});
export type ApiV1FilterJSON = z.infer<typeof ApiV1Filter>;
