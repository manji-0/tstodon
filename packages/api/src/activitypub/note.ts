import { z } from "zod";
import { ApEmoji, ApImage } from "./actor";
import { ApUri, withContext } from "./context";
import { ApCuratedCollection } from "./curated-collection";
import { ApHashtag } from "./hashtag";

/**
 * A media attachment, as Mastodon's `NoteSerializer` federates it: its
 * description as `name`, the blurhash, a focal point when one is set, the
 * original's dimensions when they were read, and a video's custom thumbnail
 * as `icon`.
 */
export const ApDocument = z.object({
  type: z.literal("Document"),
  mediaType: z.string(),
  url: ApUri,
  name: z.string().nullable(),
  blurhash: z.string().nullable(),
  focalPoint: z.tuple([z.number(), z.number()]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  icon: ApImage.optional(),
});
export type ApDocumentJSON = z.infer<typeof ApDocument>;

/** An account a note mentions. */
export const ApMention = z.object({
  type: z.literal("Mention"),
  href: ApUri,
  name: z.string().startsWith("@"),
});
export type ApMentionJSON = z.infer<typeof ApMention>;

export { ApHashtag, type ApHashtagJSON } from "./hashtag";

/**
 * Who may quote the note (GoToSocial's `interactionPolicy`, FEP-044f): as
 * Mastodon, automatic approval only, naming the public collection, the
 * author's followers, or the author alone.
 */
export const ApInteractionPolicy = z.object({
  canQuote: z.object({ automaticApproval: z.array(ApUri).length(1) }),
});
export type ApInteractionPolicyJSON = z.infer<typeof ApInteractionPolicy>;

/**
 * One page of a status's `replies` (Mastodon's `RepliesController`): replies
 * as their URIs, and the page after it. The page a status embeds has no `id`.
 */
export const ApRepliesPage = z.object({
  id: ApUri.optional(),
  type: z.literal("CollectionPage"),
  next: ApUri.optional(),
  partOf: ApUri,
  items: z.array(ApUri),
});
export type ApRepliesPageJSON = z.infer<typeof ApRepliesPage>;

/**
 * A status's `replies` collection, as Mastodon's `NoteSerializer` embeds it:
 * its first page holds a few of the author's own replies, and `next` leads to
 * the replies of other accounts.
 */
export const ApReplies = z.object({
  id: ApUri,
  type: z.literal("Collection"),
  first: ApRepliesPage,
});
export type ApRepliesJSON = z.infer<typeof ApReplies>;

const noteFields = {
  id: ApUri,
  attributedTo: ApUri,
  /** The status's page in the web app (Mastodon's `url_for`). */
  url: ApUri,
  content: z.string(),
  published: z.iso.datetime({ offset: true }),
  /** When it was last edited; Mastodon applies an `Update` only with a newer one. */
  updated: z.iso.datetime({ offset: true }).optional(),
  to: z.array(ApUri),
  cc: z.array(ApUri),
  sensitive: z.boolean(),
  summary: z.string().nullable(),
  inReplyTo: ApUri.nullable(),
  replies: ApReplies,
  attachment: z.array(ApDocument),
  /**
   * Mentions first, then hashtags, custom emoji and the collections the note
   * tags, as Mastodon's `virtual_tags`.
   */
  tag: z.array(z.discriminatedUnion("type", [ApMention, ApHashtag, ApEmoji, ApCuratedCollection])),
  interactionPolicy: ApInteractionPolicy,
  /** The quoted status (FEP-044f), with Misskey's and Fedibird's names. */
  quote: ApUri.optional(),
  quoteUri: ApUri.optional(),
  _misskey_quote: ApUri.optional(),
  /** The quoted author's stamp, once the quote is accepted. */
  quoteAuthorization: ApUri.optional(),
};

/** A poll option of a `Question`, with its votes. */
export const ApQuestionOption = z.object({
  type: z.literal("Note"),
  name: z.string(),
  replies: z.object({ type: z.literal("Collection"), totalItems: z.number().int().nonnegative() }),
});
export type ApQuestionOptionJSON = z.infer<typeof ApQuestionOption>;

/** A local status without a poll, as Mastodon's `NoteSerializer`. */
export const ApNote = z.object({ type: z.literal("Note"), ...noteFields });
export type ApNoteJSON = z.infer<typeof ApNote>;

/**
 * A local status with a poll: `oneOf` (single choice) or `anyOf` options,
 * `endTime`, `closed` once over, and `votersCount` unless the totals are
 * hidden until it ends.
 */
export const ApQuestion = z.object({
  type: z.literal("Question"),
  ...noteFields,
  oneOf: z.array(ApQuestionOption).optional(),
  anyOf: z.array(ApQuestionOption).optional(),
  endTime: z.iso.datetime({ offset: true }),
  closed: z.iso.datetime({ offset: true }).optional(),
  votersCount: z.number().int().nonnegative().optional(),
});
export type ApQuestionJSON = z.infer<typeof ApQuestion>;

/** A local status: the object a `Create`, `Update` or `QuoteRequest` carries. */
export const ApStatusObject = z.discriminatedUnion("type", [ApNote, ApQuestion]);
export type ApStatusObjectJSON = z.infer<typeof ApStatusObject>;

/**
 * A page of a status's `replies` as its link serves it (Mastodon's
 * `RepliesController`): a local reply embedded as its note, any other as its
 * URI.
 */
export const ApRepliesServedPage = ApRepliesPage.extend({
  id: ApUri,
  items: z.array(z.union([ApUri, ApStatusObject])),
});
export type ApRepliesServedPageJSON = z.infer<typeof ApRepliesServedPage>;

/** A page of a status's `replies` as served at its link. */
export const ApRepliesPageDocument = withContext(ApRepliesServedPage);
export type ApRepliesPageDocumentJSON = z.infer<typeof ApRepliesPageDocument>;

/** A status's `replies` collection as served at its URI, its first page embedded. */
export const ApRepliesDocument = withContext(ApReplies.extend({ first: ApRepliesServedPage }));
export type ApRepliesDocumentJSON = z.infer<typeof ApRepliesDocument>;

/** A local status as served at its URI. */
export const ApStatusDocument = z.discriminatedUnion("type", [
  withContext(ApNote),
  withContext(ApQuestion),
]);
export type ApStatusDocumentJSON = z.infer<typeof ApStatusDocument>;

/**
 * One vote on a remote poll, as Mastodon sends it: a `Note` named after the
 * chosen option, answering the `Question`, with no content.
 */
export const ApPollVote = z.object({
  id: ApUri,
  type: z.literal("Note"),
  attributedTo: ApUri,
  name: z.string(),
  inReplyTo: ApUri,
  published: z.iso.datetime({ offset: true }),
  to: z.array(ApUri).length(1),
});
export type ApPollVoteJSON = z.infer<typeof ApPollVote>;

/** What a deleted status leaves behind. */
export const ApTombstone = z.object({
  id: ApUri,
  type: z.literal("Tombstone"),
  atomUri: ApUri,
});
export type ApTombstoneJSON = z.infer<typeof ApTombstone>;

/**
 * A FEP-044f `QuoteAuthorization`, the quoted author's stamp approving one
 * status quoting theirs (Mastodon's `QuoteAuthorizationSerializer`).
 */
export const ApQuoteAuthorization = z.object({
  id: ApUri,
  type: z.literal("QuoteAuthorization"),
  attributedTo: ApUri,
  interactingObject: ApUri,
  interactionTarget: ApUri,
});
export type ApQuoteAuthorizationJSON = z.infer<typeof ApQuoteAuthorization>;

export const ApQuoteAuthorizationDocument = withContext(ApQuoteAuthorization);
export type ApQuoteAuthorizationDocumentJSON = z.infer<typeof ApQuoteAuthorizationDocument>;
