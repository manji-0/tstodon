import {
  InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  type LocalReblog,
} from "@tstodon/domain";
import {
  ACTIVITY_STREAMS,
  type ApActivityDocumentOf,
  type ApActorDocumentJSON,
  type ApImageJSON,
  PUBLIC_COLLECTION,
  type ApQuestionJSON,
  type ApQuoteRequestRefJSON,
  type ApStatusDocumentJSON,
  SECURITY_V1,
} from "@tstodon/api/activitypub";
import type { z } from "zod";
import { type AccountProfile, EMPTY_ACCOUNT_PROFILE } from "./account-profile-store";
import type { ActivityJsonSchema } from "./activitypub-wire";
import type { CustomEmoji } from "./emoji";
import { escapeHtml, textToHtml } from "./html";
import { mediaPublicUrl } from "./media-keys";
import type { PollRecord } from "./poll-store";
import type { QuotePolicy } from "./quote-store";

/**
 * What a local actor shows of its profile. `Shown` carries the stored
 * profile and the custom emoji its name, bio and fields use; `Suspended`
 * strips it, as Mastodon's `ActorSerializer` does for a suspended account.
 */
export type ActorProfile =
  | Readonly<{
      kind: "Shown";
      profile: AccountProfile;
      emojis: ReadonlyArray<CustomEmoji>;
    }>
  | Readonly<{ kind: "Suspended" }>;

const SHOWN_EMPTY_PROFILE: ActorProfile = {
  kind: "Shown",
  profile: EMPTY_ACCOUNT_PROFILE,
  emojis: [],
};

/** Mastodon's actor JSON-LD terms (`context_extensions` of its `ActorSerializer`). */
const ACTOR_CONTEXT_TERMS = {
  manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
  toot: "http://joinmastodon.org/ns#",
  alsoKnownAs: { "@id": "as:alsoKnownAs", "@type": "@id" },
  movedTo: { "@id": "as:movedTo", "@type": "@id" },
  schema: "http://schema.org#",
  PropertyValue: "schema:PropertyValue",
  value: "schema:value",
  discoverable: "toot:discoverable",
  suspended: "toot:suspended",
  indexable: "toot:indexable",
  Emoji: "toot:Emoji",
} as const;

/** An avatar or header as an `Image`, with its stored content type when known. */
const actorImage = (
  identity: InstanceIdentity,
  objectKey: string | null,
  contentType: string | null,
): ApImageJSON | undefined =>
  objectKey === null
    ? undefined
    : {
        type: "Image",
        ...(contentType === null ? {} : { mediaType: contentType }),
        url: mediaPublicUrl(identity, objectKey),
      };

/** Mastodon publishes the day an account joined, not the moment. */
const publishedDay = (createdAt: string): string => `${createdAt.slice(0, 10)}T00:00:00Z`;

/**
 * A local account's `Person` (or `Service` for a bot), as Mastodon's
 * `ActorSerializer`: the bio as `summary` HTML, the avatar and header as
 * `icon` / `image`, profile fields as `PropertyValue` attachments, custom
 * emoji as `Emoji` tags, and the locked / discoverable / indexable flags. A
 * suspended account shows none of its profile and says `suspended`.
 * `alsoKnownAs` lists the accounts it moved from and `movedTo` the account it
 * moved to, each only when there is one.
 */
export const actorDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
  migration: Readonly<{ alsoKnownAs: ReadonlyArray<string>; movedTo?: string | undefined }> = {
    alsoKnownAs: [],
  },
  shown: ActorProfile = SHOWN_EMPTY_PROFILE,
): ApActorDocumentJSON => {
  const id = InstanceIdentity.actorUrl(identity, account.username);
  const profile = shown.kind === "Shown" ? shown.profile : undefined;
  const icon = profile && actorImage(identity, profile.avatarObjectKey, profile.avatarContentType);
  const image = profile && actorImage(identity, profile.headerObjectKey, profile.headerContentType);
  return {
    "@context": [ACTIVITY_STREAMS, SECURITY_V1, ACTOR_CONTEXT_TERMS],
    ...(migration.alsoKnownAs.length > 0 ? { alsoKnownAs: [...migration.alsoKnownAs] } : {}),
    ...(migration.movedTo ? { movedTo: migration.movedTo } : {}),
    id,
    type: profile?.bot ? "Service" : "Person",
    preferredUsername: account.username,
    name: profile ? account.displayName : account.username,
    summary: profile && profile.note.length > 0 ? textToHtml(profile.note) : "",
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    endpoints: {
      sharedInbox: InstanceIdentity.sharedInboxUrl(identity),
    },
    url: id,
    manuallyApprovesFollowers: profile ? account.locked : false,
    discoverable: profile ? profile.discoverable : false,
    indexable: profile ? profile.indexable : false,
    published: publishedDay(account.createdAt),
    ...(shown.kind === "Suspended" ? { suspended: true } : {}),
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: account.publicKeyPem,
    },
    tag:
      shown.kind === "Shown"
        ? shown.emojis.map((emoji) => ({
            type: "Emoji",
            name: `:${emoji.shortcode}:`,
            icon: { type: "Image", url: emoji.url },
          }))
        : [],
    attachment: (profile?.fields ?? []).map((field) => ({
      type: "PropertyValue",
      name: field.name,
      value: escapeHtml(field.value),
    })),
    ...(icon ? { icon } : {}),
    ...(image ? { image } : {}),
  };
};

const usersPrefix = (identity: InstanceIdentity): string => {
  const sample = InstanceIdentity.actorUrl(identity, "_");
  return sample.slice(0, sample.lastIndexOf("/") + 1);
};

export const parseLocalActorUsername = (
  identity: InstanceIdentity,
  value: string,
): string | undefined => {
  const actorPrefix = usersPrefix(identity);
  if (!value.startsWith(actorPrefix)) {
    return undefined;
  }
  const rest = value.slice(actorPrefix.length);
  const username = rest.split("/")[0];
  return username && username.length > 0 ? username : undefined;
};

export const parseLocalStatusId = (
  identity: InstanceIdentity,
  value: string,
): string | undefined => {
  const actorPrefix = usersPrefix(identity);
  if (!value.startsWith(actorPrefix)) {
    return undefined;
  }
  const match = value.match(/\/statuses\/([^/]+)\/?$/);
  return match?.[1];
};

export const activityPayloadFromJson = (
  raw: z.infer<typeof ActivityJsonSchema>,
): Record<string, unknown> => {
  const object = raw.object;
  const objectId = typeof object === "string" ? object : object.id;
  return {
    kind: raw.type,
    id: raw.id,
    actor: raw.actor,
    object: objectId,
  };
};

/**
 * The `Delete` for a local note, as Mastodon sends it: a `Tombstone` object,
 * addressed like the note so it reaches the same followers and mentions.
 */
export const noteDeleteActivity = (
  note: Pick<ApStatusDocumentJSON, "id" | "attributedTo" | "to" | "cc">,
): ApActivityDocumentOf<"Delete"> => ({
  "@context": ACTIVITY_STREAMS,
  id: `${note.id}#delete`,
  type: "Delete",
  actor: note.attributedTo,
  to: note.to,
  cc: note.cc,
  object: { id: note.id, type: "Tombstone", atomUri: note.id },
});

/** An `Announce` as delivered, with its `@context`. */
export type AnnounceDocument = ApActivityDocumentOf<"Announce">;

/** A `Like` as delivered, with its `@context`. */
export type LikeDocument = ApActivityDocumentOf<"Like">;

/** A status as ActivityPub names it: its object URI and its author's actor URI. */
export type ActivityObjectRef = Readonly<{ uri: string; authorUri: string }>;

/** A local note's {@link ActivityObjectRef}. */
export const localNoteRef = (
  identity: InstanceIdentity,
  author: LocalAccount,
  statusId: string,
): ActivityObjectRef => {
  const authorUri = InstanceIdentity.actorUrl(identity, author.username);
  return { uri: `${authorUri}/statuses/${statusId}`, authorUri };
};

/**
 * The `Announce` for a local boost, as Mastodon sends it: addressed by the
 * boost's visibility, with the boosted note's author in `cc`.
 */
export const announceActivity = (
  identity: InstanceIdentity,
  booster: LocalAccount,
  reblog: LocalReblog,
  boosted: ActivityObjectRef,
): AnnounceDocument => {
  const actor = InstanceIdentity.actorUrl(identity, booster.username);
  const followers = `${actor}/followers`;
  const author = boosted.authorUri;
  const [to, cc] =
    reblog.visibility.kind === "Public"
      ? [[PUBLIC_COLLECTION], [author, followers]]
      : reblog.visibility.kind === "Unlisted"
        ? [[followers], [PUBLIC_COLLECTION, author]]
        : [[followers], [author]];
  return {
    "@context": ACTIVITY_STREAMS,
    id: `${actor}/statuses/${reblog.id}/activity`,
    type: "Announce",
    actor,
    published: reblog.createdAt,
    to,
    cc,
    object: boosted.uri,
  };
};

/**
 * The `Like` for a local account's favourite, as Mastodon sends it (its id
 * names the favourite), addressed to the liked status's author.
 */
export const likeActivity = (
  identity: InstanceIdentity,
  liker: LocalAccount,
  favouriteId: string,
  liked: ActivityObjectRef,
): LikeDocument => {
  const actor = InstanceIdentity.actorUrl(identity, liker.username);
  return {
    "@context": ACTIVITY_STREAMS,
    id: `${actor}#likes/${favouriteId}`,
    type: "Like",
    actor,
    to: [liked.authorUri],
    object: liked.uri,
  };
};

/** Withdraws an {@link announceActivity} or {@link likeActivity}, reaching the same audience. */
export const undoActivity = (
  activity: AnnounceDocument | LikeDocument,
): ApActivityDocumentOf<"Undo"> => {
  const { "@context": _context, ...object } = activity;
  return {
    "@context": ACTIVITY_STREAMS,
    id: `${activity.id}/undo`,
    type: "Undo",
    actor: activity.actor,
    to: activity.to,
    ...(object.type === "Announce" ? { cc: object.cc } : {}),
    object,
  };
};

/** An account a note mentions, as its `Mention` tag names it. */
export type NoteMention = Readonly<{ href: string; name: string }>;

/**
 * A media attachment as Mastodon federates it, a `Document`: its type, public
 * URL, description as `name`, blurhash, focal point when one is set, and the
 * original's `width` / `height` when the upload read them.
 */
export type NoteAttachment = Readonly<{
  mediaType: string;
  url: string;
  name: string | null;
  blurhash: string | null;
  focalPoint: readonly [number, number] | undefined;
  dimensions: Readonly<{ width: number; height: number }> | undefined;
}>;

/**
 * A note's attachments, and whether its author is sensitized: Mastodon's
 * `NoteSerializer` marks such an author's notes sensitive.
 */
export type NoteMedia = Readonly<{
  attachments: ReadonlyArray<NoteAttachment>;
  authorSensitized: boolean;
}>;

/**
 * The poll fields of a `Question`, as Mastodon reads them: `oneOf` or `anyOf`
 * options with their vote counts, `endTime`, `closed` once over, and `votersCount`.
 * A poll that hides its totals keeps them out of the document until it ends.
 */
const questionFields = (
  poll: PollRecord,
): Pick<ApQuestionJSON, "oneOf" | "anyOf" | "endTime" | "closed" | "votersCount"> => {
  const closed = Date.parse(poll.expiresAt) <= Date.now();
  const hidden = poll.hideTotals && !closed;
  const options = poll.options.map((option) => ({
    type: "Note" as const,
    name: option.title,
    replies: { type: "Collection" as const, totalItems: hidden ? 0 : option.votesCount },
  }));
  return {
    ...(poll.multiple ? { anyOf: options } : { oneOf: options }),
    endTime: poll.expiresAt,
    ...(closed ? { closed: poll.expiresAt } : {}),
    ...(hidden ? {} : { votersCount: poll.votersCount }),
  };
};

/**
 * The status a note quotes, as its `quote` property names it, the quoted
 * author's stamp once the quote is accepted (`quoteAuthorization`), and a
 * remote quoted author to address, as Mastodon's silent mention
 * (`Quote#ensure_quoted_access`).
 */
export type NoteQuote = Readonly<{
  uri: string;
  authorization: string | undefined;
  addressAuthor: string | undefined;
}>;

export const noteDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  extras: Readonly<{
    quote?: NoteQuote | undefined;
    mentions?: ReadonlyArray<NoteMention>;
    /** The parent's URI, and a remote parent author to address alongside the mentions. */
    reply?: Readonly<{ inReplyTo: string; addressAuthor: string | undefined }> | undefined;
    /** A note with a poll federates as a `Question`. */
    poll?: PollRecord | undefined;
    /** The note's media in order. Required: an `Update` without them clears them remotely. */
    media: NoteMedia;
    /** Who may quote the note, federated as `interactionPolicy.canQuote`. */
    quotePolicy: QuotePolicy;
  }>,
): ApStatusDocumentJSON => {
  const { quote, mentions = [], reply, poll, quotePolicy } = extras;
  const { attachments, authorSensitized } = extras.media;
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  const id = `${actor}/statuses/${note.id}`;
  const followers = `${actor}/followers`;
  const mentioned = [
    ...new Set([
      ...mentions.map((mention) => mention.href),
      ...(reply?.addressAuthor ? [reply.addressAuthor] : []),
      ...(quote?.addressAuthor ? [quote.addressAuthor] : []),
    ]),
  ];
  // Mastodon's addressing: mentioned accounts are `cc`, except that a direct
  // note is addressed `to` them alone.
  const to =
    note.visibility.kind === "Public"
      ? [PUBLIC_COLLECTION]
      : note.visibility.kind === "Direct"
        ? mentioned
        : [followers];
  const cc =
    note.visibility.kind === "Public"
      ? [followers, ...mentioned]
      : note.visibility.kind === "Unlisted"
        ? [PUBLIC_COLLECTION, ...mentioned]
        : note.visibility.kind === "FollowersOnly"
          ? mentioned
          : [];
  const quoteUri = quote?.uri ?? "";
  const quotes = quoteUri.length > 0;
  // Mastodon's `NoteSerializer#interaction_policy`: outgoing policies are
  // automatic only, and one that lets nobody quote names the author alone.
  const automaticApproval =
    quotePolicy === "public"
      ? [PUBLIC_COLLECTION]
      : quotePolicy === "followers"
        ? [followers]
        : [actor];
  const terms = {
    // FEP-044f names the `quote` property for a quote post.
    ...(quotes
      ? {
          quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
          quote_uri: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
          _misskey_quote: { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
          quoteAuthorization: {
            "@id": "https://w3id.org/fep/044f#quoteAuthorization",
            "@type": "@id",
          },
        }
      : {}),
    ...(poll || attachments.length > 0 ? { toot: "http://joinmastodon.org/ns#" } : {}),
    ...(poll ? { votersCount: "toot:votersCount" } : {}),
    ...(attachments.length > 0
      ? {
          blurhash: "toot:blurhash",
          focalPoint: { "@container": "@list", "@id": "toot:focalPoint" },
        }
      : {}),
    gts: "https://gotosocial.org/ns#",
    interactionPolicy: { "@id": "gts:interactionPolicy", "@type": "@id" },
    canQuote: { "@id": "gts:canQuote", "@type": "@id" },
    automaticApproval: { "@id": "gts:automaticApproval", "@type": "@id" },
  };
  const fields = {
    "@context": [ACTIVITY_STREAMS, terms] satisfies ApStatusDocumentJSON["@context"],
    ...(quotes ? { quote: quoteUri, quote_uri: quoteUri, _misskey_quote: quoteUri } : {}),
    ...(quotes && quote?.authorization ? { quoteAuthorization: quote.authorization } : {}),
    id,
    attributedTo: actor,
    content: note.contentHtml,
    published: note.createdAt,
    // Mastodon applies an `Update` of a note only when `updated` is newer
    // than the edit it has; without it an edit never reaches it.
    ...(note.editedAt === null ? {} : { updated: note.editedAt }),
    to,
    cc,
    sensitive: note.sensitive || (authorSensitized && attachments.length > 0),
    summary: note.spoilerText.length > 0 ? note.spoilerText : null,
    inReplyTo: reply?.inReplyTo ?? null,
    attachment: attachments.map((media) => ({
      type: "Document" as const,
      mediaType: media.mediaType,
      url: media.url,
      name: media.name,
      blurhash: media.blurhash,
      ...(media.focalPoint
        ? { focalPoint: [media.focalPoint[0], media.focalPoint[1]] as [number, number] }
        : {}),
      ...(media.dimensions
        ? { width: media.dimensions.width, height: media.dimensions.height }
        : {}),
    })),
    tag: mentions.map((mention) => ({
      type: "Mention" as const,
      href: mention.href,
      name: mention.name,
    })),
    interactionPolicy: { canQuote: { automaticApproval } },
  };
  return poll
    ? { ...fields, type: "Question", ...questionFields(poll) }
    : { ...fields, type: "Note" };
};

/**
 * The `QuoteRequest` a local author sends the remote quoted author, as
 * Mastodon's `QuoteRequestSerializer` with `allow_post_inlining`: the quoting
 * note rides along inline as `instrument`, so the quoted server need not fetch it.
 */
export const quoteRequestActivity = (
  id: string,
  actor: string,
  quotedUri: string,
  note: ApStatusDocumentJSON,
): ApActivityDocumentOf<"QuoteRequest"> => {
  const { "@context": noteContext, ...instrument } = note;
  const [, ...noteTerms] = typeof noteContext === "string" ? [noteContext] : noteContext;
  return {
    "@context": [
      ACTIVITY_STREAMS,
      { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" },
      ...noteTerms,
    ],
    id,
    type: "QuoteRequest",
    actor,
    object: quotedUri,
    instrument,
  };
};

/** A remote `QuoteRequest` as an answer names it back, the quoting note by URI. */
export type QuoteRequestRef = Omit<ApQuoteRequestRefJSON, "type">;

/**
 * A local quoted author's answer to a `QuoteRequest`, as Mastodon's
 * `AcceptQuoteRequestSerializer`, whose `result` is the stamp, and
 * `RejectQuoteRequestSerializer`. Both are numbered by the quote.
 */
export const quoteRequestAnswerActivity = (
  answer: Readonly<{ kind: "Accept"; stamp: string }> | Readonly<{ kind: "Reject" }>,
  quotedAuthorUri: string,
  quoteId: string,
  request: QuoteRequestRef,
): ApActivityDocumentOf<"Accept" | "Reject"> => ({
  "@context": [ACTIVITY_STREAMS, { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" }],
  id: `${quotedAuthorUri}#${answer.kind === "Accept" ? "accepts" : "rejects"}/quote_requests/${quoteId}`,
  type: answer.kind,
  actor: quotedAuthorUri,
  ...(answer.kind === "Accept" ? { result: answer.stamp } : {}),
  object: { type: "QuoteRequest", ...request },
});
