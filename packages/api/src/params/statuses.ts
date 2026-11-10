import { z } from "zod";

/**
 * `POST /api/v1/statuses/:id/reblog`. `visibility` is `public`, `unlisted`
 * or `private`; it stays a string so the server can answer an unknown one
 * with Mastodon's `Invalid visibility` instead of a parse error.
 */
export const ApiReblogParamsSchema = z.object({
  visibility: z.string().optional(),
});
export type ApiReblogParams = z.input<typeof ApiReblogParamsSchema>;

/**
 * One entry of `media_attributes`: the alt text and focal point (`"x,y"`)
 * of an attachment the status keeps, applied in the same request as an
 * edit. Mastodon's web UI sends a `null` description for an attachment
 * without one, which clears it, as a blank one does.
 */
export const ApiStatusMediaAttributeParamsSchema = z.object({
  id: z.string().min(1),
  description: z.string().nullish(),
  focus: z.string().nullish(),
});
export type ApiStatusMediaAttributeParams = z.input<typeof ApiStatusMediaAttributeParamsSchema>;

/** `poll` of a new or edited status: `expires_in` in seconds. */
export const ApiStatusPollParamsSchema = z.object({
  options: z.array(z.string()),
  expires_in: z.number().optional(),
  multiple: z.boolean().optional(),
  hide_totals: z.boolean().optional(),
});
export type ApiStatusPollParams = z.input<typeof ApiStatusPollParamsSchema>;

/**
 * `POST /api/v1/statuses`. `visibility` and `quote_approval_policy` stay
 * strings so the server answers an unknown one with Mastodon's `Invalid
 * visibility` / `Invalid quote_approval_policy` instead of a parse error.
 * The fields Mastodon's web UI sends as `null` when the post does not use
 * them (`in_reply_to_id`, `language`, `poll`, `quoted_status_id`) are
 * nullable; the server reads a `null` field as a missing one, as Rails does.
 * `media_attributes` is an array, or in a form an object keyed by position
 * (`media_attributes[0][id]`).
 */
export const ApiCreateStatusParamsSchema = z.object({
  status: z.string().optional(),
  spoiler_text: z.string().optional(),
  sensitive: z.boolean().optional(),
  visibility: z.string().optional(),
  language: z.string().nullish(),
  in_reply_to_id: z.string().nullish(),
  scheduled_at: z.string().nullish(),
  quoted_status_id: z.string().nullish(),
  quote_approval_policy: z.string().optional(),
  media_ids: z.array(z.string()).optional(),
  media_attributes: z.array(ApiStatusMediaAttributeParamsSchema).optional(),
  poll: ApiStatusPollParamsSchema.nullish(),
});
export type ApiCreateStatusParams = z.input<typeof ApiCreateStatusParamsSchema>;

/**
 * `PUT /api/v1/statuses/:id`: the whole revision, in the fields a new
 * status takes. A field left out keeps the status's value; `in_reply_to_id`,
 * `scheduled_at` and `quoted_status_id` are read and ignored (a status's
 * thread, schedule and quote do not change on an edit).
 */
export const ApiUpdateStatusParamsSchema = ApiCreateStatusParamsSchema;
export type ApiUpdateStatusParams = z.input<typeof ApiUpdateStatusParamsSchema>;

/**
 * `DELETE /api/v1/statuses/:id` (query or body): with `delete_media` the
 * attachments go with the status; without it they stay, unattached, for a
 * "Delete & redraft".
 */
export const ApiDeleteStatusParamsSchema = z.object({
  delete_media: z.boolean().optional(),
});
export type ApiDeleteStatusParams = z.input<typeof ApiDeleteStatusParamsSchema>;
