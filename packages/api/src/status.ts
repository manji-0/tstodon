import { z } from "zod";
import { ApiAccount } from "./account";
import { ApiCollection } from "./collection";
import { ApiCustomEmoji } from "./custom-emoji";
import { ApiFilterResult } from "./filter";
import { ApiMediaAttachment } from "./media-attachment";
import { ApiPoll } from "./poll";
import { ApiTag, ApiTagHistory } from "./tag";
import {
  PREVIEW_CARD_TYPES,
  QUOTE_APPROVAL_AUDIENCES,
  type QuoteApprovalAudience,
  type QuotePolicyName,
  STATUS_VISIBILITIES,
  USER_QUOTE_POLICIES,
} from "./values";

/** `Status#application`: only on the viewer's own statuses. */
export const ApiStatusApplication = z.object({
  name: z.string(),
  website: z.string().nullable().optional(),
});
export type ApiStatusApplicationJSON = z.infer<typeof ApiStatusApplication>;

/** `Status#mentions[]` (`REST::StatusSerializer::MentionSerializer`). */
export const ApiMention = z.object({
  id: z.string(),
  username: z.string(),
  url: z.string(),
  acct: z.string(),
});
export type ApiMentionJSON = z.infer<typeof ApiMention>;

/** `PreviewCard#authors[]` (Mastodon 4.3). */
export const ApiPreviewCardAuthor = z.object({
  name: z.string(),
  url: z.string(),
  account: ApiAccount.nullable().optional(),
});
export type ApiPreviewCardAuthorJSON = z.infer<typeof ApiPreviewCardAuthor>;

/** `REST::PreviewCardSerializer`. */
export const ApiPreviewCard = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  language: z.string().nullable(),
  type: z.literal(PREVIEW_CARD_TYPES),
  author_name: z.string(),
  author_url: z.string(),
  provider_name: z.string(),
  provider_url: z.string(),
  html: z.string(),
  width: z.number(),
  height: z.number(),
  image: z.string().nullable(),
  image_description: z.string(),
  embed_url: z.string(),
  blurhash: z.string().nullable(),
  published_at: z.string().nullable(),
  authors: z.array(ApiPreviewCardAuthor),
});
export type ApiPreviewCardJSON = z.infer<typeof ApiPreviewCard>;

/** `REST::Trends::LinkSerializer`: a preview card with its daily uses. */
export const ApiTrendsLink = ApiPreviewCard.extend({ history: z.array(ApiTagHistory) });
export type ApiTrendsLinkJSON = z.infer<typeof ApiTrendsLink>;

/** The audiences in `quote_approval` lists, with the author-side `nobody`. */
export type ApiQuotePolicy = QuoteApprovalAudience | QuotePolicyName;
export type { UserQuotePolicy as ApiUserQuotePolicy, QuoteState as ApiQuoteState } from "./values";

/** `Status#quote_approval` (Mastodon 4.4). */
export const ApiQuotePolicyEntity = z.object({
  automatic: z.array(z.literal(QUOTE_APPROVAL_AUDIENCES)),
  manual: z.array(z.literal(QUOTE_APPROVAL_AUDIENCES)),
  current_user: z.literal(USER_QUOTE_POLICIES),
});
export type ApiQuotePolicyJSON = z.infer<typeof ApiQuotePolicyEntity>;

/** The states in which a quote still shows its status (accepted, or labelled for the viewer). */
export const QUOTE_SHOWN_STATES = [
  "accepted",
  "blocked_account",
  "blocked_domain",
  "muted_account",
] as const;
/** The states in which a quote shows no status. */
export const QUOTE_EMPTY_STATES = [
  "pending",
  "rejected",
  "revoked",
  "deleted",
  "unauthorized",
] as const;

/**
 * `REST::ShallowQuoteSerializer`: the `quote` of a status shown inside a
 * quote names its quoted status by id only.
 */
export const ApiShallowQuote = z.discriminatedUnion("state", [
  z.object({ state: z.literal(QUOTE_SHOWN_STATES), quoted_status_id: z.string() }),
  z.object({ state: z.literal(QUOTE_EMPTY_STATES), quoted_status_id: z.null() }),
]);
export type ApiShallowQuoteJSON = z.infer<typeof ApiShallowQuote>;

const statusFields = {
  id: z.string(),
  created_at: z.string(),
  in_reply_to_id: z.string().nullable(),
  in_reply_to_account_id: z.string().nullable(),
  sensitive: z.boolean(),
  spoiler_text: z.string(),
  visibility: z.literal(STATUS_VISIBILITIES),
  language: z.string().nullable(),
  uri: z.string(),
  url: z.string().nullable(),
  replies_count: z.number(),
  reblogs_count: z.number(),
  favourites_count: z.number(),
  quotes_count: z.number(),
  edited_at: z.string().nullable(),
  /** The viewer's interactions: only for a signed-in viewer. */
  favourited: z.boolean().optional(),
  reblogged: z.boolean().optional(),
  muted: z.boolean().optional(),
  bookmarked: z.boolean().optional(),
  pinned: z.boolean().optional(),
  filtered: z.array(ApiFilterResult).optional(),
  content: z.string(),
  /** The source text: only where Mastodon renders it (delete and redraft). */
  text: z.string().nullable().optional(),
  application: ApiStatusApplication.nullable().optional(),
  account: ApiAccount,
  media_attachments: z.array(ApiMediaAttachment),
  mentions: z.array(ApiMention),
  tags: z.array(ApiTag),
  emojis: z.array(ApiCustomEmoji),
  card: ApiPreviewCard.nullable(),
  poll: ApiPoll.nullable(),
  quote_approval: ApiQuotePolicyEntity,
  /** Mastodon 4.7. */
  tagged_collections: z.array(ApiCollection),
};

/**
 * A status shown inside another's quote (`REST::ShallowStatusSerializer`):
 * its own quote by id only, which ends the nesting. It is never a boost.
 */
export const ApiQuotedStatus = z.object({
  ...statusFields,
  reblog: z.null().optional(),
  quote: ApiShallowQuote.nullable().optional(),
});
export type ApiQuotedStatusJSON = z.infer<typeof ApiQuotedStatus>;

/**
 * `REST::QuoteSerializer`: an accepted quote shows its status (also when the
 * viewer's block, domain block or mute labels it); any other state none.
 */
export const ApiQuote = z.discriminatedUnion("state", [
  z.object({ state: z.literal(QUOTE_SHOWN_STATES), quoted_status: ApiQuotedStatus }),
  z.object({ state: z.literal(QUOTE_EMPTY_STATES), quoted_status: z.null() }),
]);
export type ApiQuoteJSON = z.infer<typeof ApiQuote>;

/** A status that is not a boost (an original): what a boost's `reblog` holds. */
export const ApiOriginalStatus = z.object({
  ...statusFields,
  reblog: z.null().optional(),
  quote: ApiQuote.nullable().optional(),
});
export type ApiOriginalStatusJSON = z.infer<typeof ApiOriginalStatus>;

/**
 * `REST::StatusSerializer`. A boost has the boosted status as `reblog`; a
 * boosted status is never itself a boost.
 */
export const ApiStatus = z.object({
  ...statusFields,
  reblog: ApiOriginalStatus.nullable().optional(),
  quote: ApiQuote.nullable().optional(),
});
export type ApiStatusJSON = z.infer<typeof ApiStatus>;

/** `REST::ContextSerializer`. */
export const ApiContext = z.object({
  ancestors: z.array(ApiStatus),
  descendants: z.array(ApiStatus),
});
export type ApiContextJSON = z.infer<typeof ApiContext>;

/** `REST::StatusEditSerializer` (`/api/v1/statuses/:id/history`). */
export const ApiStatusEdit = z.object({
  content: z.string(),
  spoiler_text: z.string(),
  sensitive: z.boolean(),
  created_at: z.string(),
  account: ApiAccount,
  poll: z.object({ options: z.array(z.object({ title: z.string() })) }).nullable(),
  media_attachments: z.array(ApiMediaAttachment),
  emojis: z.array(ApiCustomEmoji),
});
export type ApiStatusEditJSON = z.infer<typeof ApiStatusEdit>;

/** `REST::StatusSourceSerializer`. */
export const ApiStatusSource = z.object({
  id: z.string(),
  text: z.string(),
  spoiler_text: z.string(),
});
export type ApiStatusSourceJSON = z.infer<typeof ApiStatusSource>;

/** `REST::TranslationSerializer`. */
export const ApiTranslation = z.object({
  detected_source_language: z.string(),
  language: z.string(),
  provider: z.string(),
  content: z.string(),
  spoiler_text: z.string(),
  media_attachments: z.array(z.object({ id: z.string(), description: z.string() })).optional(),
  poll: z
    .object({
      id: z.string(),
      options: z.array(z.object({ title: z.string() })),
    })
    .optional(),
});
export type ApiTranslationJSON = z.infer<typeof ApiTranslation>;
