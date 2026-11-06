import {
  InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  type LocalReblog,
} from "@tstodon/domain";
import type { z } from "zod";
import type { ActivityJsonSchema } from "./activitypub-wire";
import type { PollRecord } from "./poll-store";
import type { QuotePolicy } from "./quote-store";

/**
 * A local account's `Person`. As Mastodon's `ActorSerializer`, `alsoKnownAs`
 * lists the accounts it moved from and `movedTo` the account it moved to,
 * each only when there is one.
 */
export const actorDocument = (
  identity: InstanceIdentity,
  account: LocalAccount,
  migration: Readonly<{ alsoKnownAs: ReadonlyArray<string>; movedTo?: string | undefined }> = {
    alsoKnownAs: [],
  },
): Record<string, unknown> => {
  const id = InstanceIdentity.actorUrl(identity, account.username);
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
      {
        alsoKnownAs: { "@id": "as:alsoKnownAs", "@type": "@id" },
        movedTo: { "@id": "as:movedTo", "@type": "@id" },
      },
    ],
    ...(migration.alsoKnownAs.length > 0 ? { alsoKnownAs: migration.alsoKnownAs } : {}),
    ...(migration.movedTo ? { movedTo: migration.movedTo } : {}),
    id,
    type: "Person",
    preferredUsername: account.username,
    name: account.displayName,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    endpoints: {
      sharedInbox: InstanceIdentity.sharedInboxUrl(identity),
    },
    url: id,
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: account.publicKeyPem,
    },
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
  note: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const id = typeof note.id === "string" ? note.id : "";
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${id}#delete`,
    type: "Delete",
    actor: note.attributedTo,
    to: note.to,
    cc: note.cc,
    object: { id, type: "Tombstone", atomUri: id },
  };
};

const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

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
): Record<string, unknown> => {
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
    "@context": "https://www.w3.org/ns/activitystreams",
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
): Record<string, unknown> => {
  const actor = InstanceIdentity.actorUrl(identity, liker.username);
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}#likes/${favouriteId}`,
    type: "Like",
    actor,
    to: [liked.authorUri],
    object: liked.uri,
  };
};

/** Withdraws an {@link announceActivity} or {@link likeActivity}, reaching the same audience. */
export const undoActivity = (
  activity: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `${String(activity.id)}/undo`,
  type: "Undo",
  actor: activity.actor,
  to: activity.to,
  cc: activity.cc,
  object: { ...activity, "@context": undefined },
});

/** An account a note mentions, as its `Mention` tag names it. */
export type NoteMention = Readonly<{ href: string; name: string }>;

/**
 * A media attachment as Mastodon federates it, a `Document`: its type, public
 * URL, description as `name`, and focal point when one is set.
 */
export type NoteAttachment = Readonly<{
  mediaType: string;
  url: string;
  name: string | null;
  focalPoint: readonly [number, number] | undefined;
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
const questionFields = (poll: PollRecord): Record<string, unknown> => {
  const closed = Date.parse(poll.expiresAt) <= Date.now();
  const hidden = poll.hideTotals && !closed;
  const options = poll.options.map((option) => ({
    type: "Note",
    name: option.title,
    replies: { type: "Collection", totalItems: hidden ? 0 : option.votesCount },
  }));
  return {
    [poll.multiple ? "anyOf" : "oneOf"]: options,
    endTime: poll.expiresAt,
    ...(closed ? { closed: poll.expiresAt } : {}),
    ...(hidden ? {} : { votersCount: poll.votersCount }),
  };
};

/** The status a note quotes, as its `quote` property names it. */
export type NoteQuote = Readonly<{ uri: string }>;

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
): Record<string, unknown> => {
  const { quote, mentions = [], reply, poll, quotePolicy } = extras;
  const { attachments, authorSensitized } = extras.media;
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  const id = `${actor}/statuses/${note.id}`;
  const followers = `${actor}/followers`;
  const mentioned = [
    ...new Set([
      ...mentions.map((mention) => mention.href),
      ...(reply?.addressAuthor ? [reply.addressAuthor] : []),
    ]),
  ];
  // Mastodon's addressing: mentioned accounts are `cc`, except that a direct
  // note is addressed `to` them alone.
  const to =
    note.visibility.kind === "Public"
      ? ["https://www.w3.org/ns/activitystreams#Public"]
      : note.visibility.kind === "Direct"
        ? mentioned
        : [followers];
  const cc =
    note.visibility.kind === "Public"
      ? [followers, ...mentioned]
      : note.visibility.kind === "Unlisted"
        ? ["https://www.w3.org/ns/activitystreams#Public", ...mentioned]
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
  return {
    "@context": ["https://www.w3.org/ns/activitystreams", terms],
    ...(quotes ? { quote: quoteUri, quote_uri: quoteUri, _misskey_quote: quoteUri } : {}),
    ...(poll ? questionFields(poll) : {}),
    id,
    type: poll ? "Question" : "Note",
    attributedTo: actor,
    content: note.contentHtml,
    published: note.createdAt,
    to,
    cc,
    sensitive: note.sensitive || (authorSensitized && attachments.length > 0),
    summary: note.spoilerText.length > 0 ? note.spoilerText : null,
    inReplyTo: reply?.inReplyTo ?? null,
    attachment: attachments.map((media) => ({
      type: "Document",
      mediaType: media.mediaType,
      url: media.url,
      name: media.name,
      blurhash: null,
      ...(media.focalPoint ? { focalPoint: media.focalPoint } : {}),
    })),
    tag: mentions.map((mention) => ({ type: "Mention", href: mention.href, name: mention.name })),
    interactionPolicy: { canQuote: { automaticApproval } },
  };
};
