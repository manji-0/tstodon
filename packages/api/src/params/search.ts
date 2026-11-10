import { z } from "zod";

/**
 * `GET /api/v2/search`. `type` is `accounts`, `statuses` or `hashtags`
 * (blank: all three); it is a string here because the server takes an
 * unknown one as no type. `offset` pages only when a `type` is given.
 * `exclude_unreviewed` (leave out hashtags an admin has not reviewed) is
 * read and ignored: tstodon's hashtag search does not filter by review.
 */
export const ApiSearchParamsSchema = z.object({
  q: z.string().optional(),
  type: z.string().optional(),
  resolve: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  exclude_unreviewed: z.boolean().optional(),
});
export type ApiSearchParams = z.input<typeof ApiSearchParamsSchema>;

/**
 * `GET /api/v1/accounts/search`. `following` keeps the results to accounts
 * the viewer follows; `offset` pages.
 */
export const ApiSearchAccountsParamsSchema = z.object({
  q: z.string().optional(),
  resolve: z.boolean().optional(),
  following: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export type ApiSearchAccountsParams = z.input<typeof ApiSearchAccountsParamsSchema>;
