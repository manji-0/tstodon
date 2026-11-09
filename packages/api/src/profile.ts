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

/**
 * What tstodon's `/api/v1/profile` answers: Mastodon's Profile with the
 * rendered forms beside the plain text (the web UI reads {@link ApiProfile}).
 */
export const ApiProfileDocument = ApiProfile.extend({
  /** The note as HTML, as `Account#note` renders it (`note` is the plain text). */
  formatted_note: z.string(),
  /** The fields with HTML values, as `Account#fields` (`fields` holds the plain text). */
  formatted_fields: z.array(ApiAccountField),
});
export type ApiProfileDocumentJSON = z.infer<typeof ApiProfileDocument>;
