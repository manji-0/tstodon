import { z } from "zod";
import { ApActor } from "./actor";
import { ApUri, withContext } from "./context";
import {
  ApCuratedCollection,
  ApFeatureAuthorization,
  ApFeaturedItem,
  ApFeatureRequest,
} from "./curated-collection";
import { ApHashtag, ApPollVote, ApQuoteAuthorization, ApStatusObject, ApTombstone } from "./note";

/*
 * The activities tstodon sends, as Mastodon's `ActivityPub::*Serializer`s
 * shape them. Each `Ap*` schema is the activity as another one embeds it
 * (an `Undo`'s object, an `Accept`'s); `ApActivityDocument` is a delivered
 * or served activity, with its `@context`.
 */

const audience = z.array(ApUri);

/** `Follow` of a remote actor (`FollowSerializer`). */
export const ApFollow = z.object({
  id: ApUri,
  type: z.literal("Follow"),
  actor: ApUri,
  object: ApUri,
});
export type ApFollowJSON = z.infer<typeof ApFollow>;

/** `Block` (`BlockSerializer`). */
export const ApBlock = z.object({
  id: ApUri,
  type: z.literal("Block"),
  actor: ApUri,
  object: ApUri,
});
export type ApBlockJSON = z.infer<typeof ApBlock>;

/** `Like` of a status (`LikeSerializer`), to its author. */
export const ApLike = z.object({
  id: ApUri,
  type: z.literal("Like"),
  actor: ApUri,
  to: audience,
  object: ApUri,
});
export type ApLikeJSON = z.infer<typeof ApLike>;

/** `Announce` of a status, a boost, addressed by the boost's visibility. */
export const ApAnnounce = z.object({
  id: ApUri,
  type: z.literal("Announce"),
  actor: ApUri,
  published: z.iso.datetime({ offset: true }),
  to: audience,
  cc: audience,
  object: ApUri,
});
export type ApAnnounceJSON = z.infer<typeof ApAnnounce>;

/**
 * `Create` of a local status, or of a vote on a remote poll. As Mastodon's,
 * the status's terms are on the activity's `@context`; the status carries none.
 */
export const ApCreate = z.object({
  id: ApUri,
  type: z.literal("Create"),
  actor: ApUri,
  published: z.iso.datetime({ offset: true }).optional(),
  to: audience.optional(),
  cc: audience.optional(),
  object: z.union([ApStatusObject, ApPollVote]),
});
export type ApCreateJSON = z.infer<typeof ApCreate>;

/**
 * `Update` of a local status (an edit, a poll's counts), its terms on the
 * activity as in a `Create`, or of the actor (`UpdateSerializer`: the
 * actor's terms on the activity, addressed to the public).
 */
export const ApUpdate = z.object({
  id: ApUri,
  type: z.literal("Update"),
  actor: ApUri,
  /** Not on a collection's `Update` (`UpdateFeaturedCollectionSerializer`). */
  published: z.iso.datetime({ offset: true }).optional(),
  to: audience.optional(),
  object: z.union([ApStatusObject, ApActor, ApCuratedCollection]),
});
export type ApUpdateJSON = z.infer<typeof ApUpdate>;

/**
 * `Delete` of a local status (a `Tombstone`), of a quote stamp, or of the
 * actor itself, named by its URI (`DeleteActorSerializer`).
 */
export const ApDelete = z.object({
  id: ApUri,
  type: z.literal("Delete"),
  actor: ApUri,
  to: audience,
  cc: audience.optional(),
  object: z.union([ApTombstone, ApQuoteAuthorization, ApFeatureAuthorization, ApUri]),
});
export type ApDeleteJSON = z.infer<typeof ApDelete>;

/** A remote `QuoteRequest` as an answer names it back, the quoting note by URI. */
export const ApQuoteRequestRef = z.object({
  type: z.literal("QuoteRequest"),
  id: ApUri,
  actor: ApUri,
  object: ApUri,
  instrument: ApUri,
});
export type ApQuoteRequestRefJSON = z.infer<typeof ApQuoteRequestRef>;

/**
 * `Accept` of a remote actor's `Follow`, or of a `QuoteRequest`
 * (`AcceptQuoteRequestSerializer`, whose `result` is the stamp).
 */
export const ApAccept = z.object({
  id: ApUri,
  type: z.literal("Accept"),
  actor: ApUri,
  /** A feature request's answer is addressed to the collection's owner. */
  to: ApUri.optional(),
  result: ApUri.optional(),
  /** A `FeatureRequest` is named by its id (`AcceptFeatureRequestSerializer`). */
  object: z.union([ApFollow, ApQuoteRequestRef, ApUri]),
});
export type ApAcceptJSON = z.infer<typeof ApAccept>;

/** `Reject` of a remote actor's `Follow`, or of a `QuoteRequest`. */
export const ApReject = z.object({
  id: ApUri,
  type: z.literal("Reject"),
  actor: ApUri,
  to: ApUri.optional(),
  object: z.union([ApFollow, ApQuoteRequestRef, ApUri]),
});
export type ApRejectJSON = z.infer<typeof ApReject>;

/** `Undo` of a boost, a favourite, a follow or a block, reaching the same audience. */
export const ApUndo = z.object({
  id: ApUri,
  type: z.literal("Undo"),
  actor: ApUri,
  to: audience.optional(),
  cc: audience.optional(),
  object: z.discriminatedUnion("type", [ApAnnounce, ApLike, ApFollow, ApBlock]),
});
export type ApUndoJSON = z.infer<typeof ApUndo>;

/** `Move` of the account to another (`MoveSerializer`). */
export const ApMove = z.object({
  id: ApUri,
  type: z.literal("Move"),
  actor: ApUri,
  object: ApUri,
  target: ApUri,
});
export type ApMoveJSON = z.infer<typeof ApMove>;

/**
 * `Flag`, a report forwarded from the instance actor (`FlagSerializer`):
 * the reported account first, then the reported posts.
 */
export const ApFlag = z.object({
  id: ApUri,
  type: z.literal("Flag"),
  actor: ApUri,
  content: z.string(),
  object: z.tuple([ApUri], ApUri),
});
export type ApFlagJSON = z.infer<typeof ApFlag>;

/**
 * `QuoteRequest` to a remote quoted author (`QuoteRequestSerializer` with
 * `allow_post_inlining`): the quoting status rides along as `instrument`.
 */
export const ApQuoteRequest = z.object({
  id: ApUri,
  type: z.literal("QuoteRequest"),
  actor: ApUri,
  object: ApUri,
  instrument: ApStatusObject,
});
export type ApQuoteRequestJSON = z.infer<typeof ApQuoteRequest>;

/**
 * `Add` to the actor's `featured` collection: a status by its URI, a pin
 * (`AddNoteSerializer`), or a `Hashtag`, a featured hashtag
 * (`AddHashtagSerializer`, which names the same collection). Mastodon sends
 * it without an `id`; tstodon gives it one.
 */
export const ApAdd = z.object({
  /** None on a collection's `Add`, as Mastodon sends it. */
  id: ApUri.optional(),
  type: z.literal("Add"),
  actor: ApUri,
  target: ApUri,
  /** Also a collection added to `featuredCollections`, or an item added to a collection. */
  object: z.union([ApUri, ApHashtag, ApCuratedCollection, ApFeaturedItem]),
});
export type ApAddJSON = z.infer<typeof ApAdd>;

/**
 * `Remove` from the actor's `featured` collection: a status, an unpin
 * (`RemoveNoteSerializer`), or a `Hashtag` (`RemoveHashtagSerializer`).
 */
export const ApRemove = z.object({
  /** None on a collection's or an item's `Remove`, as Mastodon sends it. */
  id: ApUri.optional(),
  type: z.literal("Remove"),
  actor: ApUri,
  target: ApUri,
  object: z.union([ApUri, ApHashtag]),
});
export type ApRemoveJSON = z.infer<typeof ApRemove>;

const activities = [
  ApFollow,
  ApBlock,
  ApLike,
  ApAnnounce,
  ApCreate,
  ApUpdate,
  ApDelete,
  ApAccept,
  ApReject,
  ApUndo,
  ApMove,
  ApFlag,
  ApQuoteRequest,
  ApAdd,
  ApRemove,
] as const;

/** Any activity tstodon sends, without its `@context`. */
export const ApActivity = z.discriminatedUnion("type", activities);
export type ApActivityJSON = z.infer<typeof ApActivity>;

/**
 * A Linked Data signature (`RsaSignature2017`), as Mastodon's
 * `LinkedDataSignature#sign!` adds it to the activities it signs, with the
 * security vocabulary appended to the `@context`.
 */
export const ApLdSignature = z.object({
  type: z.literal("RsaSignature2017"),
  creator: ApUri,
  created: z.iso.datetime(),
  expires: z.iso.datetime(),
  signatureValue: z.string(),
});
export type ApLdSignatureJSON = z.infer<typeof ApLdSignature>;

const delivered = <Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) =>
  withContext(schema).extend({ signature: ApLdSignature.optional() });

/**
 * An activity as delivered to an inbox or listed in an outbox: with its
 * `@context`, and its Linked Data signature when tstodon signs it.
 */
export const ApActivityDocument = z.discriminatedUnion("type", [
  delivered(ApFollow),
  delivered(ApBlock),
  delivered(ApLike),
  delivered(ApAnnounce),
  delivered(ApCreate),
  delivered(ApUpdate),
  delivered(ApDelete),
  delivered(ApAccept),
  delivered(ApReject),
  delivered(ApUndo),
  delivered(ApMove),
  delivered(ApFlag),
  delivered(ApQuoteRequest),
  delivered(ApAdd),
  delivered(ApRemove),
  delivered(ApFeatureRequest),
]);
export type ApActivityDocumentJSON = z.infer<typeof ApActivityDocument>;

/** The {@link ApActivityDocument} of one activity type. */
export type ApActivityDocumentOf<Type extends ApActivityDocumentJSON["type"]> = Extract<
  ApActivityDocumentJSON,
  { type: Type }
>;
