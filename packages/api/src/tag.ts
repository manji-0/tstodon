import { z } from "zod";

/** `Status#tags[]` (`REST::StatusSerializer::TagSerializer`). */
export const ApiTag = z.object({
  name: z.string(),
  url: z.string(),
});
export type ApiTagJSON = z.infer<typeof ApiTag>;

/** `Tag#history[]`: counts are strings on the wire. */
export const ApiTagHistory = z.object({
  day: z.string(),
  accounts: z.string(),
  uses: z.string(),
});
export type ApiHistoryJSON = z.infer<typeof ApiTagHistory>;

/**
 * `REST::TagSerializer`; `following` / `featuring` only for a signed-in
 * viewer. `history` holds the last days, newest first (Mastodon renders seven).
 */
export const ApiHashtag = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  history: z.tuple([ApiTagHistory], ApiTagHistory),
  following: z.boolean().optional(),
  featuring: z.boolean().optional(),
});
export type ApiHashtagJSON = z.infer<typeof ApiHashtag>;

/** `REST::FeaturedTagSerializer`: `statuses_count` is a string on the wire. */
export const ApiFeaturedTag = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  statuses_count: z.string(),
  last_status_at: z.string().nullable(),
});
export type ApiFeaturedTagJSON = z.infer<typeof ApiFeaturedTag>;
