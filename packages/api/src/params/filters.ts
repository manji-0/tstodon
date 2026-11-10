import { z } from "zod";

/**
 * A `keywords_attributes[]` entry of a v2 filter: a new keyword, or with
 * `id` an existing one to change (`_destroy` removes it).
 */
const FilterKeywordAttributes = z.object({
  id: z.string().optional(),
  keyword: z.string().optional(),
  whole_word: z.boolean().optional(),
  _destroy: z.boolean().optional(),
});

/**
 * `POST /api/v2/filters` and `PUT /api/v2/filters/:id`. Contexts and the
 * action are strings: the server stores the contexts it is given and reads an
 * unknown `filter_action` as `warn`. `expires_in` is in seconds; a blank or
 * non-positive one means no expiry. tstodon also reads a few older shapes:
 * `phrase` for `title`, `irreversible` for `filter_action=hide`, and
 * `keywords` (strings or objects) beside `keywords_attributes`; a filter with
 * no title is named after its first keyword. What `PUT` leaves out keeps its
 * value.
 */
export const ApiFilterParamsSchema = z.object({
  title: z.string().optional(),
  context: z.array(z.string()).optional(),
  filter_action: z.string().optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  keywords_attributes: z.array(FilterKeywordAttributes).optional(),
  phrase: z.string().optional(),
  irreversible: z.boolean().optional(),
  keywords: z
    .array(
      z.union([
        z.string(),
        z.object({
          id: z.string().optional(),
          keyword: z.string().optional(),
          /** Read as `true` / `1`, as before `keywords_attributes`. */
          whole_word: z.union([z.boolean(), z.string(), z.number()]).optional(),
        }),
      ]),
    )
    .optional(),
});
export type ApiFilterParams = z.input<typeof ApiFilterParamsSchema>;

/** `POST /api/v2/filters/:filter_id/statuses`. */
export const ApiCreateFilterStatusParamsSchema = z.object({
  status_id: z.string().trim().min(1),
});
export type ApiCreateFilterStatusParams = z.input<typeof ApiCreateFilterStatusParamsSchema>;
