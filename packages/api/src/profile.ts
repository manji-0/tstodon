import { z } from "zod";
import { ApiAccountField } from "./account";
import { ApiFeaturedTag } from "./tag";

/** `REST::ProfileSerializer` (`/api/v1/profile`, Mastodon 4.6). */
export const ApiProfile = z.object({
  id: z.string(),
  display_name: z.string(),
  note: z.string(),
  fields: z.array(ApiAccountField),
  avatar: z.string(),
  avatar_static: z.string(),
  avatar_description: z.string(),
  header: z.string(),
  header_static: z.string(),
  header_description: z.string(),
  locked: z.boolean(),
  bot: z.boolean(),
  hide_collections: z.boolean(),
  discoverable: z.boolean(),
  indexable: z.boolean(),
  show_media: z.boolean(),
  show_media_replies: z.boolean(),
  show_featured: z.boolean(),
  attribution_domains: z.array(z.string()),
  featured_tags: z.array(ApiFeaturedTag),
});
export type ApiProfileJSON = z.infer<typeof ApiProfile>;
