import { z } from "zod";

/**
 * `PUT /api/v1/media/:id`: alt text and focal point (`"x,y"`, each in
 * -1.0..1.0) of an attachment not yet posted. A blank or `null` description
 * clears it.
 */
export const ApiUpdateMediaParamsSchema = z.object({
  description: z.string().nullish(),
  focus: z.string().nullish(),
});
export type ApiUpdateMediaParams = z.input<typeof ApiUpdateMediaParamsSchema>;
