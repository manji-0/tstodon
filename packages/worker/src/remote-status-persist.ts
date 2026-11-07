import {
  InstanceIdentity,
  IsoInstant,
  RemoteEmojiSchema,
  QuoteInteractionPolicy,
  RemoteStatus,
  StatusId,
  type RemoteEmoji,
  RemoteActor,
  type RemoteStatus as RemoteStatusValue,
  type Hostname,
  type MentionedPost,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson } from "./federated-fetch";
import { resolveRemoteActor } from "./remote-actor-fetch";
import { entityIdAt, type IdClock, newEntityId } from "./ids";
import { parseLocalActorUsername, parseLocalStatusId } from "./activitypub";
import { findAccountByUsername } from "./account-store";
import { mediaRejectedDomains } from "./admin-domain-block-store";
import { enqueueLinkCard } from "./link-card";
import { mentionedPost, notifyFromRemote } from "./notify";
import { findThreadParent } from "./thread-context";
import { findRemoteStatusByObjectUri, upsertRemoteStatus } from "./remote-status-store";
import { publishConversationUpdate } from "./conversation-stream";
import { recordRemoteStatusMentions } from "./mention-store";
import { isTruthy, stringList } from "./form-values";
import { NoteDocumentSchema } from "./activitypub-wire";
import { remoteEmojisInTexts } from "./remote-emoji-document";
import { remotePollFromDocument } from "./remote-poll-parse";
import { type EmbeddedQuoted, type RemoteQuoteContext, syncRemoteQuote } from "./remote-quote";

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

export const noteFromUnknown = (
  raw: unknown,
  actorUri: string,
  idClock: IdClock = "Received",
): Result<RemoteStatusValue, { kind: "InvalidObject" } | RepositoryError> => {
  const document = parseNoteDocument(raw);
  if (document.isErr()) {
    return err({ kind: "InvalidObject" });
  }
  if (document.value.attributedTo !== actorUri) {
    return err({ kind: "InvalidObject" });
  }
  const publishedAt = IsoInstant.parse(document.value.published).orElse(() =>
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
    quotePolicy: QuoteInteractionPolicy.fromCanQuote(canQuoteOf(document.value.interactionPolicy), {
      actorUri,
    }),
    ...(document.value.url ? { url: document.value.url } : {}),
  });
};

const MentionTagsSchema = z.object({
  tag: z
    .array(z.object({ type: z.string().optional(), href: z.string().optional() }).passthrough())
    .optional(),
});

/** The `href` of each `Mention` tag of a note document. */
const mentionHrefs = (raw: unknown): string[] => {
  const tags = schemaResult(MentionTagsSchema)(raw);
  return (tags.isOk() ? (tags.value.tag ?? []) : []).flatMap((entry) =>
    entry.type === "Mention" && entry.href ? [entry.href] : [],
  );
};

/**
 * Local accounts a remote note addresses: its `Mention` tags plus its
 * `to`/`cc` audience, kept to exact local actor URLs.
 */
const mentionedLocalUsernames = (identity: InstanceIdentity, raw: unknown): string[] => {
  const note = parseNoteDocument(raw);
  const candidates = [
    ...mentionHrefs(raw),
    ...(note.isOk() ? [...stringList(note.value.to), ...stringList(note.value.cc)] : []),
  ];
  return [
    ...new Set(
      candidates.flatMap((uri) => {
        const username = parseLocalActorUsername(identity, uri);
        return username && InstanceIdentity.actorUrl(identity, username) === uri ? [username] : [];
      }),
    ),
  ];
};

/**
 * Record the local accounts a newly stored remote note addresses, so it can
 * reach their conversations, and notify them when asked.
 */
export const mentionedLocalAccountIds = async (
  env: Env,
  identity: InstanceIdentity,
  raw: unknown,
): Promise<string[]> => {
  const accountIds: string[] = [];
  for (const username of mentionedLocalUsernames(identity, raw)) {
    const account = await findAccountByUsername(env.DB, username);
    if (account.isOk() && account.value) {
      accountIds.push(account.value.id);
    }
  }
  return accountIds;
};

/**
 * The `MentionedPost` of a stored remote note: the local accounts it
 * addresses, the actors its `Mention` tags name, and the author of the
 * stored status it replies to.
 */
export const remoteMentionedPost = async (
  db: D1Database,
  identity: InstanceIdentity,
  raw: unknown,
  status: RemoteStatusValue,
  localAccountIds: ReadonlyArray<string>,
): Promise<MentionedPost> => {
  // The note is already stored: a failed parent read screens without the
  // parent author rather than failing the delivery after its writes.
  const parent = await findThreadParent(db, identity, { kind: "Remote", status });
  return mentionedPost(
    [...localAccountIds, ...mentionHrefs(raw)],
    parent.isOk() ? parent.value : undefined,
  );
};

const recordMentions = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  status: RemoteStatusValue,
  notify: boolean,
): Promise<Result<void, RepositoryError>> => {
  const statusId = status.id;
  const accountIds = await mentionedLocalAccountIds(env, identity, raw);
  const recorded = await recordRemoteStatusMentions(env.DB, statusId, accountIds);
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  if (status.visibility.kind === "Direct") {
    await publishConversationUpdate(env, identity, accountIds, statusId);
  }
  if (notify && accountIds.length > 0) {
    const post = await remoteMentionedPost(env.DB, identity, raw, status, accountIds);
    for (const accountId of accountIds) {
      await notifyFromRemote(
        env,
        { accountId, actorUri: actor.actorUri, kind: "mention", statusId },
        post,
      );
    }
  }
  return ok(undefined);
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

type PersistOptions = Readonly<{
  allowHosts?: ReadonlySet<string>;
  blockedHosts?: ReadonlySet<Hostname>;
  /** Notify the local accounts the note mentions, when it is newly stored (inbox `Create`). */
  notifyMentions?: boolean;
  /** Which instant a newly stored note's id sorts at; `Received` by default. */
  idClock?: IdClock;
  /**
   * How many quotes deep this note sits below the note that arrived (0 by
   * default); a note fetched as a quoted one is one deeper than its quoting
   * note. See {@link MAX_QUOTE_DEPTH}.
   */
  quoteDepth?: number;
}>;

type ObjectReference = string | Readonly<{ id: string } & Record<string, unknown>>;

/** The cached remote status for `objectUri`, or `Local` for one of this instance's own. */
const cachedRemoteStatus = async (
  env: Env,
  identity: InstanceIdentity,
  objectUri: string,
): Promise<Result<Readonly<{ kind: "Local" }> | RemoteStatusValue | undefined, RepositoryError>> =>
  parseLocalStatusId(identity, objectUri)
    ? ok({ kind: "Local" })
    : findRemoteStatusByObjectUri(env.DB, objectUri);

export const persistRemoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: ObjectReference,
  options: PersistOptions = {},
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const cached = await cachedRemoteStatus(
    env,
    identity,
    typeof object === "string" ? object : object.id,
  );
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (cached.value) {
    return ok(cached.value.kind === "Local" ? undefined : cached.value);
  }
  if (typeof object !== "string") {
    return storeRemoteNote(env, identity, actor, object, options);
  }
  const raw = await fetchActivityJson(identity, object, options);
  if (raw.isErr() || !fetchedAsItself(raw.value, object)) {
    return ok(undefined);
  }
  return storeRemoteNote(env, identity, actor, raw.value, options);
};

/**
 * Whether a note fetched from `uri` names `uri` as its id and sits on its
 * author's host, as Mastodon's `FetchRemoteStatusService` requires (and
 * {@link persistAnnouncedObject} of another actor's note): a document served
 * under one URI cannot claim another.
 */
const fetchedAsItself = (raw: unknown, uri: string): boolean => {
  const note = parseNoteDocument(raw);
  if (note.isErr() || note.value.id !== uri) {
    return false;
  }
  const host = urlHost(uri);
  return host !== undefined && host === urlHost(note.value.attributedTo);
};

/**
 * The status an `Announce` shares, cached. The booster's own note may come
 * embedded. Another actor's note is fetched from its URI, must name that URI
 * as its id and come from its author's host, and is stored under its author,
 * whose actor is resolved first, as Mastodon does.
 */
export const persistAnnouncedObject = async (
  env: Env,
  identity: InstanceIdentity,
  announcer: RemoteActor,
  object: ObjectReference,
  options: PersistOptions = {},
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const objectUri = typeof object === "string" ? object : object.id;
  const cached = await cachedRemoteStatus(env, identity, objectUri);
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (cached.value) {
    return ok(cached.value.kind === "Local" ? undefined : cached.value);
  }
  if (typeof object !== "string") {
    const embedded = parseNoteDocument(object);
    if (embedded.isOk() && embedded.value.attributedTo === announcer.actorUri) {
      return storeRemoteNote(env, identity, announcer, object, options);
    }
  }
  const raw = await fetchActivityJson(identity, objectUri, options);
  if (raw.isErr()) {
    return ok(undefined);
  }
  const note = parseNoteDocument(raw.value);
  if (note.isErr() || note.value.id !== objectUri) {
    return ok(undefined);
  }
  const authorUri = note.value.attributedTo;
  if (authorUri === announcer.actorUri) {
    return storeRemoteNote(env, identity, announcer, raw.value, options);
  }
  const authorHost = urlHost(authorUri);
  if (authorHost === undefined || authorHost !== urlHost(objectUri)) {
    return ok(undefined);
  }
  const author = await resolveRemoteActor(
    env.DB,
    identity,
    `${authorUri}#main-key`,
    authorUri,
    options,
  );
  if (author.isErr()) {
    return author.error.kind === "RepositoryError" ? err(author.error) : ok(undefined);
  }
  return storeRemoteNote(env, identity, author.value, raw.value, options);
};

/**
 * How deep quoted notes are fetched below the note that arrived, as
 * Mastodon's `VerifyQuoteService::MAX_SYNCHRONOUS_DEPTH` (2): notes at depth
 * 0, 1 and 2 fetch their quoted notes, so up to three levels are stored. A
 * note deeper than that keeps its quote of an uncached note unresolved.
 */
export const MAX_QUOTE_DEPTH = 3;

/**
 * Store an inlined copy of a quoted note when the actor that sent it vouches
 * for it, as Mastodon's `safe_prefetched_embed`: its id is `uri`, it is
 * `vouchedBy`'s own note, and it sits on `vouchedBy`'s host. Otherwise, or
 * when that actor cannot be resolved, `undefined`, and the caller fetches by
 * id instead.
 */
const persistVouchedQuoted = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  uri: string,
  embedded: EmbeddedQuoted,
  options: PersistOptions,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const note = parseNoteDocument(embedded.object);
  const host = urlHost(uri);
  if (
    note.isErr() ||
    note.value.id !== uri ||
    note.value.attributedTo !== embedded.vouchedBy ||
    host === undefined ||
    host !== urlHost(embedded.vouchedBy)
  ) {
    return ok(undefined);
  }
  if (embedded.vouchedBy === actor.actorUri) {
    return storeRemoteNote(env, identity, actor, embedded.object, options);
  }
  const author = await resolveRemoteActor(
    env.DB,
    identity,
    `${embedded.vouchedBy}#main-key`,
    embedded.vouchedBy,
    options,
  );
  if (author.isErr()) {
    return author.error.kind === "RepositoryError" ? err(author.error) : ok(undefined);
  }
  return storeRemoteNote(env, identity, author.value, embedded.object, options);
};

/**
 * How a note `actor` wrote reaches the note it quotes and that quote's stamp.
 * An uncached quoted note comes from an inlined copy its sender vouches for
 * ({@link persistVouchedQuoted}), else is fetched as an announced one, while
 * `options.quoteDepth` is under {@link MAX_QUOTE_DEPTH}; the quoted note is
 * stored one level deeper.
 */
export const remoteQuoteContext = (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: PersistOptions,
): RemoteQuoteContext => {
  const depth = options.quoteDepth ?? 0;
  const mayFetch = depth < MAX_QUOTE_DEPTH;
  const nested: PersistOptions = { ...options, notifyMentions: false, quoteDepth: depth + 1 };
  return {
    fetchOptions: options,
    mayFetch,
    resolveQuoted: async (uri, embedded) => {
      const cached = await findRemoteStatusByObjectUri(env.DB, uri);
      if (cached.isErr() || cached.value || !mayFetch) {
        return cached;
      }
      if (embedded) {
        const vouched = await persistVouchedQuoted(env, identity, actor, uri, embedded, nested);
        if (vouched.isErr() || vouched.value) {
          return vouched;
        }
      }
      return persistAnnouncedObject(env, identity, actor, uri, nested);
    },
  };
};

const urlHost = (href: string): string | undefined => {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** Store a note document `actor` wrote, with its mentions and a queued preview card. */
const storeRemoteNote = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  options: PersistOptions,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const parsed = noteFromUnknown(raw, actor.actorUri, options.idClock);
  if (parsed.isErr()) {
    return parsed.error.kind === "RepositoryError" ? err(parsed.error) : ok(undefined);
  }
  const status = await applyMediaPolicy(env, actor, parsed.value);
  const note = parseNoteDocument(raw);
  const inReplyTo = note.isOk() ? (note.value.inReplyTo ?? undefined) : undefined;
  const stored = await upsertRemoteStatus(env.DB, status, inReplyTo);
  if (stored.isErr() || stored.value === undefined) {
    return stored;
  }
  // Mention rows exist before the notifications that point at them.
  const mentions = await recordMentions(
    env,
    identity,
    actor,
    raw,
    stored.value,
    options.notifyMentions === true,
  );
  if (mentions.isErr()) {
    return err(mentions.error);
  }
  const quote = await syncRemoteQuote(
    env,
    identity,
    stored.value,
    raw,
    remoteQuoteContext(env, identity, actor, options),
  );
  if (quote.isErr()) {
    return err(quote.error);
  }
  // Preview cards are built off the request path like for local posts.
  await enqueueLinkCard(env, "RemoteStatus", stored.value.id, stored.value.contentHtml);
  return stored;
};
