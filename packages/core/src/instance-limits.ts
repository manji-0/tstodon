/**
 * Instance limits advertised by `/api/v2/instance` and enforced by the worker
 * and domain. Keep these in one place so the advertised numbers are true.
 */
export const InstanceLimits = {
  status: {
    /** Unicode code points in the post body (Mastodon counts characters). */
    maxCharacters: 500,
    maxSpoilerCharacters: 500,
    maxMediaAttachments: 4,
    charactersReservedPerUrl: 23,
  },
  poll: {
    minOptions: 2,
    maxOptions: 4,
    maxOptionCharacters: 50,
    minExpirationSeconds: 300,
    maxExpirationSeconds: 2_629_746,
  },
  account: {
    maxPinnedStatuses: 5,
    maxFeaturedTags: 10,
  },
  media: {
    maxDescriptionCharacters: 1500,
  },
} as const;

/**
 * Number of Unicode code points, which is what Mastodon counts for limits
 * (Ruby's `String#length`). Grapheme clusters are intentionally not merged.
 */
export const characterCount = (text: string): number => Array.from(text).length;
