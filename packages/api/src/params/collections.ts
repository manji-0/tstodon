import { z } from "zod";

/**
 * `POST /api/v1/collections` and `PUT /api/v1/collections/:id`
 * (`collection_creation_params`, `collection_update_params`). A field left
 * out, or `null`, is blank to Mastodon's validations; on update a field left
 * out keeps its value.
 */
export const ApiUpdateCollectionParamsSchema = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  sensitive: z.boolean().nullable().optional(),
  discoverable: z.boolean().nullable().optional(),
  tag_name: z.string().nullable().optional(),
});
export type ApiUpdateCollectionParams = z.input<typeof ApiUpdateCollectionParamsSchema>;

export const ApiCreateCollectionParamsSchema = ApiUpdateCollectionParamsSchema.extend({
  /** The accounts to feature, in order. */
  account_ids: z.array(z.string()).optional(),
});
export type ApiCreateCollectionParams = z.input<typeof ApiCreateCollectionParamsSchema>;

/** `POST /api/v1/collections/:id/items`. */
export const ApiAddCollectionItemParamsSchema = z.object({
  account_id: z.string().optional(),
});
export type ApiAddCollectionItemParams = z.input<typeof ApiAddCollectionItemParamsSchema>;
