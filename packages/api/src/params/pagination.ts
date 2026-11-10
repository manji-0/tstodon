import { z } from "zod";

/**
 * Mastodon's paging params (`max_id`, `since_id`, `min_id`, `limit`), shared
 * by the collection endpoints. Each endpoint clamps `limit` to its own
 * default and maximum.
 */
export const ApiPaginationParamsSchema = z.object({
  max_id: z.string().optional(),
  since_id: z.string().optional(),
  min_id: z.string().optional(),
  limit: z.number().optional(),
});
export type ApiPaginationParams = z.input<typeof ApiPaginationParamsSchema>;
