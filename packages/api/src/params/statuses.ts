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
