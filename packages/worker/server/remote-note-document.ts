import {
  IsoInstant,
  QuoteInteractionPolicy,
  RemoteActor,
  type RemoteEmoji,
  RemoteEmojiSchema,
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
import { entityIdAt, type IdClock, newEntityId } from "./ids";
import { remoteEmojisInTexts } from "./remote-emoji-document";
import { remotePollFromDocument } from "./remote-poll-parse";

export const parseNoteDocument = schemaResult(NoteDocumentSchema);

/** The note's language: the first `contentMap` key that is a language tag, as Mastodon reads it. */
const noteLanguage = (
  contentMap: Readonly<Record<string, unknown>> | undefined,
): RemoteStatusValue["language"] => {
  const tag = Object.keys(contentMap ?? {})
    .map((key) => key.trim().toLowerCase())
    .find((key) => /^[a-z]{2,3}(-[a-z0-9]+)?$/.test(key));
  return tag ? { kind: "Present", value: tag } : { kind: "None" };
};

const parseRemoteEmoji = schemaResult(RemoteEmojiSchema);

const parseInteractionPolicy = schemaResult(z.object({ canQuote: z.unknown().optional() }));

/** The `canQuote` of a note's `interactionPolicy`, when it has one. */
const canQuoteOf = (interactionPolicy: unknown): unknown => {
  const parsed = parseInteractionPolicy(interactionPolicy);
  return parsed.isOk() ? parsed.value.canQuote : undefined;
};

const EmojiTagsSchema = z.object({
  tag: z
    .array(
      z
        .object({
          type: z.string().optional(),
          name: z.string().optional(),
          icon: z.object({ url: z.string().optional() }).passthrough().optional(),
        })
        .passthrough(),
    )
    .optional(),
});

/** Mastodon caps a status's emoji far below this; it only bounds a hostile document. */
const MAX_EMOJIS = 50;

/**
 * The custom emoji a note declares in `Emoji` tags and actually uses in its
 * content, spoiler or poll option titles, as Mastodon keeps them.
 */
export const noteEmojis = (
  raw: unknown,
  texts: ReadonlyArray<string>,
): ReadonlyArray<RemoteEmoji> => {
  const tags = schemaResult(EmojiTagsSchema)(raw);
  const seen = new Set<string>();
  const emojis: RemoteEmoji[] = [];
  for (const tag of tags.isOk() ? (tags.value.tag ?? []) : []) {
    const shortcode = tag.name?.replace(/^:|:$/g, "");
    const url = tag.icon?.url;
    if (tag.type !== "Emoji" || !shortcode || !url || seen.has(shortcode.toLowerCase())) {
      continue;
    }
    seen.add(shortcode.toLowerCase());
    const parsed = parseRemoteEmoji({ shortcode, url });
    if (parsed.isOk()) {
      emojis.push(parsed.value);
    }
  }
  return remoteEmojisInTexts(texts, emojis).slice(0, MAX_EMOJIS);
};

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
  const id = StatusId.parse(
    idClock === "Published" ? entityIdAt(Date.parse(publishedAt.value)) : newEntityId(),
  );
  if (id.isErr()) {
    return err({ kind: "InvalidObject" });
  }
  const attachments = (document.value.attachment ?? []).flatMap((entry) => {
    const url = entry.url;
    if (!url || url.length === 0) {
      return [];
    }
    return [
      {
        url,
        mediaType: entry.mediaType ?? "",
        description: entry.name ?? "",
      },
    ];
  });
  const poll = remotePollFromDocument(document.value);
  return RemoteStatus.fromFetched({
    id: id.value,
    media: attachments,
    actorUri,
    objectUri: document.value.id,
    contentHtml: document.value.content,
    spoilerText: document.value.summary ?? "",
    visibility: RemoteStatus.visibilityFromAudience(
      stringList(document.value.to),
      stringList(document.value.cc),
    ),
    sensitive: isTruthy(document.value.sensitive),
    language: noteLanguage(document.value.contentMap),
    publishedAt: publishedAt.value,
    poll,
    emojis: noteEmojis(raw, [
      document.value.content,
      document.value.summary ?? "",
      ...(poll.kind === "NoPoll" ? [] : poll.options.map((option) => option.title)),
    ]),
    quotePolicy: QuoteInteractionPolicy.fromCanQuote(
      canQuoteOf(document.value.interactionPolicy),
      author,
    ),
    ...(document.value.url ? { url: document.value.url } : {}),
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
