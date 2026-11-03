import {
  InstanceIdentity,
  IsoInstant,
  RemoteStatus,
  StatusId,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
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
import { notifyFromRemote } from "./notify";
import { findRemoteStatusByObjectUri, upsertRemoteStatus } from "./remote-status-store";
import { recordRemoteStatusMentions } from "./mention-store";
import { isTruthy, stringList } from "./form-values";
import { NoteDocumentSchema } from "./activitypub-wire";
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
    poll: remotePollFromDocument(document.value),
    ...(document.value.url ? { url: document.value.url } : {}),
  });
};

const MentionTagsSchema = z.object({
  tag: z
    .array(z.object({ type: z.string().optional(), href: z.string().optional() }).passthrough())
    .optional(),
});

/**
 * Local accounts a remote note addresses: its `Mention` tags plus its
 * `to`/`cc` audience, kept to exact local actor URLs.
 */
const mentionedLocalUsernames = (identity: InstanceIdentity, raw: unknown): string[] => {
  const tags = schemaResult(MentionTagsSchema)(raw);
  const note = parseNoteDocument(raw);
  const candidates = [
    ...(tags.isOk() ? (tags.value.tag ?? []) : []).flatMap((entry) =>
      entry.type === "Mention" && entry.href ? [entry.href] : [],
    ),
    ...(note.isOk() ? [...stringList(note.value.to), ...stringList(note.value.cc)] : []),
  ];
  const usernames = new Set<string>();
  for (const uri of candidates) {
    const username = parseLocalActorUsername(identity, uri);
    if (username && InstanceIdentity.actorUrl(identity, username) === uri) {
      usernames.add(username);
    }
  }
  return [...usernames];
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

const recordMentions = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  statusId: string,
  notify: boolean,
): Promise<Result<void, RepositoryError>> => {
  const accountIds = await mentionedLocalAccountIds(env, identity, raw);
  const recorded = await recordRemoteStatusMentions(env.DB, statusId, accountIds);
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  if (notify) {
    for (const accountId of accountIds) {
      await notifyFromRemote(env, {
        accountId,
        actorUri: actor.actorUri,
        kind: "mention",
        statusId,
      });
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
  return rejected.has(actor.domain.toLowerCase()) ? { ...status, media: [] } : status;
};

type PersistOptions = Readonly<{
  allowHosts?: ReadonlySet<string>;
  blockedHosts?: ReadonlySet<string>;
  /** Notify the local accounts the note mentions, when it is newly stored (inbox `Create`). */
  notifyMentions?: boolean;
  /** Which instant a newly stored note's id sorts at; `Received` by default. */
  idClock?: IdClock;
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
  const raw =
    typeof object === "string" ? await fetchActivityJson(identity, object, options) : ok(object);
  if (raw.isErr()) {
    return ok(undefined);
  }
  return storeRemoteNote(env, identity, actor, raw.value, options);
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
  if (stored.isErr()) {
    return stored;
  }
  // Mention rows exist before the notifications that point at them.
  const mentions = await recordMentions(
    env,
    identity,
    actor,
    raw,
    stored.value.id,
    options.notifyMentions === true,
  );
  if (mentions.isErr()) {
    return err(mentions.error);
  }
  // Preview cards are built off the request path like for local posts.
  await enqueueLinkCard(env, "RemoteStatus", stored.value.id, stored.value.contentHtml);
  return stored;
};
