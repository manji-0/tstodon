import { z } from "zod";

/**
 * `GET /api/v2/search`. `type` is `accounts`, `statuses` or `hashtags`
 * (blank: all three); it is a string here because the server takes an
 * unknown one as no type. `offset` pages only when a `type` is given.
 */
export const ApiSearchParamsSchema = z.object({
  q: z.string().optional(),
  type: z.string().optional(),
  resolve: z.boolean().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export type ApiSearchParams = z.input<typeof ApiSearchParamsSchema>;
