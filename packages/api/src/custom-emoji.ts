import { z } from "zod";

/** `REST::CustomEmojiSerializer`. */
export const ApiCustomEmoji = z.object({
  shortcode: z.string(),
  url: z.string(),
  static_url: z.string(),
  visible_in_picker: z.boolean(),
  /** Present where the category was loaded (the instance's emoji list). */
  category: z.string().nullable().optional(),
  /** Mastodon 4.7. */
  featured: z.boolean().optional(),
});
export type ApiCustomEmojiJSON = z.infer<typeof ApiCustomEmoji>;
