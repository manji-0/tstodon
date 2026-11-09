import { z } from "zod";
import { ApActor } from "./actor";
import { ApUri, withContext } from "./context";
import {
  ApPollVote,
  ApQuoteAuthorization,
  ApStatusDocument,
  ApStatusObject,
  ApTombstone,
} from "./note";

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
 * `Create` of a local status, or of a vote on a remote poll. tstodon embeds
 * the status with its own `@context` (where Mastodon lifts the terms to the
 * activity's); the activity's `@context` is ActivityStreams alone.
 */
export const ApCreate = z.object({
  id: ApUri,
  type: z.literal("Create"),
  actor: ApUri,
  published: z.iso.datetime({ offset: true }).optional(),
  to: audience.optional(),
  cc: audience.optional(),
  object: z.union([ApStatusDocument, ApPollVote]),
});
export type ApCreateJSON = z.infer<typeof ApCreate>;

/**
 * `Update` of a local status (an edit, a poll's counts), embedded with its
 * `@context` as in a `Create`, or of the actor (`UpdateSerializer`: the
 * actor's terms on the activity, addressed to the public).
 */
export const ApUpdate = z.object({
  id: ApUri,
  type: z.literal("Update"),
  actor: ApUri,
  published: z.iso.datetime({ offset: true }),
  to: audience.optional(),
  object: z.union([ApStatusDocument, ApActor]),
});
export type ApUpdateJSON = z.infer<typeof ApUpdate>;

/** `Delete` of a local status (a `Tombstone`) or of a quote stamp. */
export const ApDelete = z.object({
  id: ApUri,
  type: z.literal("Delete"),
  actor: ApUri,
  to: audience,
  cc: audience.optional(),
  object: z.union([ApTombstone, ApQuoteAuthorization]),
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
  result: ApUri.optional(),
  object: z.union([ApFollow, ApQuoteRequestRef]),
});
export type ApAcceptJSON = z.infer<typeof ApAccept>;

/** `Reject` of a remote actor's `Follow`, or of a `QuoteRequest`. */
export const ApReject = z.object({
  id: ApUri,
  type: z.literal("Reject"),
  actor: ApUri,
  object: z.union([ApFollow, ApQuoteRequestRef]),
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
] as const;

/** Any activity tstodon sends, without its `@context`. */
export const ApActivity = z.discriminatedUnion("type", activities);
export type ApActivityJSON = z.infer<typeof ApActivity>;

/** An activity as delivered to an inbox or listed in an outbox: with its `@context`. */
export const ApActivityDocument = z.discriminatedUnion("type", [
  withContext(ApFollow),
  withContext(ApBlock),
  withContext(ApLike),
  withContext(ApAnnounce),
  withContext(ApCreate),
  withContext(ApUpdate),
  withContext(ApDelete),
  withContext(ApAccept),
  withContext(ApReject),
  withContext(ApUndo),
  withContext(ApMove),
  withContext(ApFlag),
  withContext(ApQuoteRequest),
]);
export type ApActivityDocumentJSON = z.infer<typeof ApActivityDocument>;

/** The {@link ApActivityDocument} of one activity type. */
export type ApActivityDocumentOf<Type extends ApActivityDocumentJSON["type"]> = Extract<
  ApActivityDocumentJSON,
  { type: Type }
>;
