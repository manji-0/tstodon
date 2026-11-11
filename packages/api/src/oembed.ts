import { z } from "zod";

/**
 * Mastodon's `OEmbedSerializer`: an oEmbed 1.0 `rich` document for a local
 * status (`GET /api/oembed`, `GET /api/web/embeds/:id`). `height` is `null`
 * unless the request named `maxheight`.
 */
export const ApiOEmbed = z.object({
  type: z.literal("rich"),
  version: z.literal("1.0"),
  author_name: z.string(),
  author_url: z.string(),
  provider_name: z.string(),
  provider_url: z.string(),
  cache_age: z.number(),
  html: z.string(),
  width: z.number(),
  height: z.number().nullable(),
});
export type ApiOEmbedJSON = z.infer<typeof ApiOEmbed>;
