import { z } from "zod";

/** `GET /api/v1/suggestions` and `/api/v2/suggestions`. */
export const ApiGetSuggestionsParamsSchema = z.object({
  limit: z.number().optional(),
});
export type ApiGetSuggestionsParams = z.input<typeof ApiGetSuggestionsParamsSchema>;
