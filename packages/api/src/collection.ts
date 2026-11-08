import { z } from "zod";
import { ApiTag } from "./tag";

/** A collection's account item (Mastodon 4.7). */
export const ApiCollectionAccountItem = z.object({
  id: z.string(),
  /** Only when the item is accepted, or the collection is the viewer's own. */
  account_id: z.string().optional(),
  state: z.literal(["pending", "accepted", "rejected", "revoked"]),
  created_at: z.string(),
});
export type CollectionAccountItem = z.infer<typeof ApiCollectionAccountItem>;

/** `REST::BaseCollectionSerializer` (Mastodon 4.7). */
export const ApiCollection = z.object({
  account_id: z.string(),
  id: z.string(),
  uri: z.string(),
  url: z.string(),
  local: z.boolean(),
  item_count: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  tag: ApiTag.nullable(),
  language: z.string().nullable(),
  sensitive: z.boolean(),
  discoverable: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  items: z.array(ApiCollectionAccountItem),
});
export type ApiCollectionJSON = z.infer<typeof ApiCollection>;
