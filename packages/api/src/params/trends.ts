import { z } from "zod";

/**
 * `GET /api/v1/trends/tags`, `/statuses` and `/links`: `offset` pages,
 * `limit` defaults to 10 for tags and links (at most 20) and 20 for
 * statuses (at most 40).
 */
export const ApiGetTrendsParamsSchema = z.object({
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export type ApiGetTrendsParams = z.input<typeof ApiGetTrendsParamsSchema>;
