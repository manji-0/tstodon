import { z } from "zod";
import { ApUri } from "./context";

/** A hashtag a note carries (Mastodon's `HashtagSerializer`): the tag page and `#name`. */
export const ApHashtag = z.object({
  type: z.literal("Hashtag"),
  href: ApUri,
  name: z.string().startsWith("#"),
});
export type ApHashtagJSON = z.infer<typeof ApHashtag>;
