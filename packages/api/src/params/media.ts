import { z } from "zod";

/**
 * `PUT /api/v1/media/:id`: alt text and focal point (`"x,y"`, each in
 * -1.0..1.0) of an attachment not yet posted. A blank or `null` description
 * clears it. `thumbnail` (multipart, a file) is read and ignored: tstodon
 * keeps no custom thumbnails.
 */
export const ApiUpdateMediaParamsSchema = z.object({
  description: z.string().nullish(),
  focus: z.string().nullish(),
  thumbnail: z.unknown().optional(),
});
export type ApiUpdateMediaParams = z.input<typeof ApiUpdateMediaParamsSchema>;

/**
 * `POST /api/v2/media` (and `/api/v1/media`), multipart: the `file`, with
 * the fields `PUT /api/v1/media/:id` takes. `file` is a file, which the
 * server checks itself (`file is required`).
 */
export const ApiUploadMediaParamsSchema = ApiUpdateMediaParamsSchema.extend({
  file: z.unknown(),
});
export type ApiUploadMediaParams = z.input<typeof ApiUploadMediaParamsSchema>;
