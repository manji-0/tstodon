import { z } from "zod";
import { ApiAccount } from "./account";
import { ApiCollection } from "./collection";
import { ApiStatus } from "./status";
import { ApiHashtag } from "./tag";

export type ApiSearchType = "accounts" | "statuses" | "hashtags";

/** `REST::SearchSerializer` (`/api/v2/search`); `collections` since Mastodon 4.7. */
export const ApiSearchResults = z.object({
  accounts: z.array(ApiAccount),
  statuses: z.array(ApiStatus),
  hashtags: z.array(ApiHashtag),
  collections: z.array(ApiCollection),
});
export type ApiSearchResultsJSON = z.infer<typeof ApiSearchResults>;
