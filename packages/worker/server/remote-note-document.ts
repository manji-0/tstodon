import {
  IsoInstant,
  QuoteInteractionPolicy,
  RemoteActor,
  type RemoteEmoji,
  RemoteStatus,
  type RemoteStatus as RemoteStatusValue,
  StatusId,
  type QuotePolicyAuthor,
} from "@tstodon/domain";
import { isHashtagName, normalizeHashtag, schemaResult } from "@tstodon/core";
import { err, type Result } from "neverthrow";
import { z } from "zod";
import { NoteDocumentSchema } from "./activitypub-wire";
import { mediaRejectedDomains } from "./admin-domain-block-store";
import { nowIso } from "./clock";
import { isTruthy, stringList } from "./form-values";
import { linkify } from "./html";
import { entityIdAt, type IdClock, newEntityId } from "./ids";
import { remoteAttachmentMetadata } from "./remote-attachment";
import { declaredEmojis, remoteEmojisInTexts } from "./remote-emoji-document";
import { remotePollFromDocument } from "./remote-poll-parse";
import { httpUrl } from "./sanitize-html";

export const parseNoteDocument = schemaResult(NoteDocumentSchema);

type NoteDocument = z.infer<typeof NoteDocumentSchema>;

type LanguageMap = Readonly<Record<string, unknown>>;

/** A language map that has an entry, as Mastodon's `content_language_map?` and its siblings. */
const filledMap = (map: LanguageMap | undefined): LanguageMap | undefined =>
  map && Object.keys(map).length > 0 ? map : undefined;

/**
 * The note's language: the first key that is a language tag of its
 * `contentMap`, or else of its `nameMap` or `summaryMap`, the map Mastodon's
 * `StatusParser#raw_language_code` reads.
 */
const noteLanguage = (document: NoteDocument): RemoteStatusValue["language"] => {
  const map =
    filledMap(document.contentMap) ?? filledMap(document.nameMap) ?? filledMap(document.summaryMap);
  const tag = Object.keys(map ?? {})
    .map((key) => key.trim().toLowerCase())
    .find((key) => /^[a-z]{2,3}(-[a-z0-9]+)?$/.test(key));
  return tag ? { kind: "Present", value: tag } : { kind: "None" };
};

/** Ruby's `presence`: a string with more than blanks, else `undefined`. */
const present = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** The first value of a language map, as Mastodon reads `nameMap` and `summaryMap`. */
const firstOf = (map: LanguageMap | undefined): unknown => Object.values(filledMap(map) ?? {})[0];

const parseUrlLink = schemaResult(
  z.looseObject({ href: z.unknown().optional(), mimeType: z.unknown().optional() }),
);

/**
 * A note's `url` as Mastodon's `url_to_href(url, 'text/html')`: a string, the
 * first of a list of strings, or else the first entry that is a string or a
 * `Link` whose `mimeType` is `text/html` or absent (a string has no
 * `mimeType`, so it counts as `text/html`). PeerTube's links name a
 * `mediaType` instead, so its first link, the watch page, is taken. Only an
 * `http(s)` URL is kept, as `StatusParser#url`.
 */
const noteUrl = (url: unknown): string | undefined => {
  const links: ReadonlyArray<unknown> = Array.isArray(url) ? url : [url];
  const first = links[0];
  const chosen =
    typeof first === "string"
      ? first
      : links
          .flatMap((entry) => {
            if (typeof entry === "string") {
              return [{ href: entry, mimeType: undefined }];
            }
            const link = parseUrlLink(entry);
            return link.isOk() ? [link.value] : [];
          })
          .find((link) => (present(link.mimeType) ?? "text/html") === "text/html")?.href;
  return typeof chosen === "string" ? httpUrl(chosen) : undefined;
};

const parseAttachmentLink = schemaResult(
  z.looseObject({ href: z.unknown().optional(), mediaType: z.unknown().optional() }),
);

/**
 * An attachment's `url` and the media type its `Link` names, as Mastodon's
 * `url_to_href(url)` and `url_to_media_type(url)`: a string, the first of a
 * list, or the `href` and `mediaType` of a `Link` (the first of a list).
 */
const attachmentUrl = (url: unknown): Readonly<{ href: unknown; mediaType: unknown }> => {
  const first: unknown = Array.isArray(url) ? url[0] : url;
  if (typeof first === "string") {
    return { href: first, mediaType: undefined };
  }
  const link = parseAttachmentLink(first);
  return link.isOk()
    ? { href: link.value.href, mediaType: link.value.mediaType }
    : { href: undefined, mediaType: undefined };
};

type AttachmentDocument = NoteDocument["attachment"][number];

/** An attachment with an `href` is a link (a Lemmy link post), not media, as Mastodon's `process_attachments`. */
const isLinkAttachment = (entry: AttachmentDocument): boolean => present(entry.href) !== undefined;

/**
 * The URL of the preview card of a note: the `href` of its first `Link`
 * attachment, as Mastodon's `@links.first`, or `undefined` when it has none
 * and the first link of its text is unfurled instead.
 */
export const noteCardUrl = (raw: unknown): string | undefined => {
  const document = parseNoteDocument(raw);
  const href = document.isOk() ? document.value.attachment.find(isLinkAttachment)?.href : undefined;
  return typeof href === "string" ? httpUrl(href) : undefined;
};

/**
 * The text and spoiler text Mastodon stores for a note
 * (`StatusParser#processed_text`, `#processed_spoiler_text`). A converted
 * object's text is its name as a heading, its summary, and a link to its
 * `url`, or else its id; its content is not read, an `Article`'s neither, and
 * it has no spoiler text.
 */
const noteText = (
  document: NoteDocument,
  url: string | undefined,
): Readonly<{ contentHtml: string; spoilerText: string }> => {
  if (document.type === "Note" || document.type === "Question") {
    return { contentHtml: document.content, spoilerText: document.summary ?? "" };
  }
  const title = present(document.name) ?? present(firstOf(document.nameMap));
  const summary = present(document.summary) ?? present(firstOf(document.summaryMap));
  return {
    contentHtml: [title && `<h2>${title}</h2>`, summary, linkify(url ?? document.id)]
      .filter((part) => part !== undefined)
      .join("\n\n"),
    spoilerText: "",
  };
};

const parseInteractionPolicy = schemaResult(z.object({ canQuote: z.unknown().optional() }));

/** The `canQuote` of a note's `interactionPolicy`, when it has one. */
const canQuoteOf = (interactionPolicy: unknown): unknown => {
  const parsed = parseInteractionPolicy(interactionPolicy);
  return parsed.isOk() ? parsed.value.canQuote : undefined;
};

/** Mastodon caps a status's emoji far below this; it only bounds a hostile document. */
const MAX_EMOJIS = 50;

/**
 * The custom emoji a note declares in `Emoji` tags and actually uses in its
 * content, spoiler or poll option titles, as Mastodon keeps them.
 */
export const noteEmojis = (
  raw: unknown,
  texts: ReadonlyArray<string>,
): ReadonlyArray<RemoteEmoji> =>
  remoteEmojisInTexts(
    texts,
    declaredEmojis(raw, (shortcode) => shortcode.toLowerCase()),
  ).slice(0, MAX_EMOJIS);

const TaggedSchema = z.object({ tag: z.unknown().optional() });
const HashtagTagSchema = z.object({
  type: z.union([z.string(), z.array(z.unknown())]),
  name: z.string(),
});

/**
 * A note's hashtags: the names of the `Hashtag` objects of its `tag`, as
 * Mastodon reads them (`ActivityPub::Activity::Create#process_hashtag`,
 * `ProcessStatusUpdateService#update_tags!`), not the hashtags its content
 * reads as. `tag` may be one object, and `type` a list that includes
 * `Hashtag`. Each name is stored as `normalizeHashtag` writes it (which drops
 * a leading `#`) and kept once, in the note's order, when it is a tag's name.
 */
export const noteHashtags = (raw: unknown): ReadonlyArray<string> => {
  const tagged = schemaResult(TaggedSchema)(raw);
  const tag = tagged.isOk() ? tagged.value.tag : undefined;
  const entries: ReadonlyArray<unknown> = Array.isArray(tag) ? tag : [tag];
  const names = entries.flatMap((entry) => {
    const hashtag = schemaResult(HashtagTagSchema)(entry);
    if (hashtag.isErr()) {
      return [];
    }
    const { type, name } = hashtag.value;
    return (typeof type === "string" ? type === "Hashtag" : type.includes("Hashtag"))
      ? [normalizeHashtag(name)]
      : [];
  });
  return [...new Set(names.filter(isHashtagName))];
};

export const noteFromUnknown = (
  raw: unknown,
  author: QuotePolicyAuthor,
  idClock: IdClock = "Received",
): Result<RemoteStatusValue, { kind: "InvalidObject" }> => {
  const actorUri = author.actorUri;
  const document = parseNoteDocument(raw);
  if (document.isErr()) {
    return err({ kind: "InvalidObject" });
  }
  if (document.value.attributedTo !== actorUri) {
    return err({ kind: "InvalidObject" });
  }
  const publishedAt = IsoInstant.parseRemote(document.value.published).orElse(() =>
    IsoInstant.parse(nowIso()),
  );
  if (publishedAt.isErr()) {
    return err({ kind: "InvalidObject" });
  }
  // As Mastodon's `Create#process_status_params`: a note whose `updated`
  // differs from its `published` is stored as edited then.
  const updatedAt = IsoInstant.parseRemote(document.value.updated ?? "").unwrapOr(undefined);
  const editedAt = updatedAt === publishedAt.value ? undefined : updatedAt;
  const id = StatusId.parse(
    idClock === "Published" ? entityIdAt(Date.parse(publishedAt.value)) : newEntityId(),
  );
  if (id.isErr()) {
    return err({ kind: "InvalidObject" });
  }
  const attachments = document.value.attachment.flatMap((entry) => {
    const url = attachmentUrl(entry.url);
    if (isLinkAttachment(entry) || typeof url.href !== "string" || url.href.length === 0) {
      return [];
    }
    return [
      {
        url: url.href,
        mediaType: entry.mediaType ?? (typeof url.mediaType === "string" ? url.mediaType : ""),
        description: entry.name ?? "",
        ...remoteAttachmentMetadata(entry),
      },
    ];
  });
  const poll = remotePollFromDocument(document.value);
  const url = noteUrl(document.value.url);
  const { contentHtml, spoilerText } = noteText(document.value, url);
  return RemoteStatus.fromFetched({
    id: id.value,
    media: attachments,
    actorUri,
    objectUri: document.value.id,
    contentHtml,
    spoilerText,
    visibility: RemoteStatus.visibilityFromAudience(
      stringList(document.value.to),
      stringList(document.value.cc),
    ),
    sensitive: isTruthy(document.value.sensitive),
    language: noteLanguage(document.value),
    publishedAt: publishedAt.value,
    editedAt,
    poll,
    emojis: noteEmojis(raw, [
      contentHtml,
      spoilerText,
      ...(poll.kind === "NoPoll" ? [] : poll.options.map((option) => option.title)),
    ]),
    quotePolicy: QuoteInteractionPolicy.fromCanQuote(
      canQuoteOf(document.value.interactionPolicy),
      author,
    ),
    ...(url ? { url } : {}),
  });
};

/** An admin block with `reject_media` keeps the post but not its attachments. */
export const applyMediaPolicy = async (
  env: Env,
  actor: RemoteActor,
  status: RemoteStatusValue,
): Promise<RemoteStatusValue> => {
  const rejected = await mediaRejectedDomains(env.DB);
  return RemoteActor.onAnyHost(actor, rejected) ? { ...status, media: [] } : status;
};
