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
import { newEntityId } from "./ids";
import { parseLocalActorUsername, parseLocalStatusId } from "./activitypub";
import { findAccountByUsername } from "./account-store";
import { mediaRejectedDomains } from "./admin-domain-block-store";
import { enqueueLinkCard } from "./link-card";
import { notifyFromRemote } from "./notify";
import {
  findRemoteStatusByObjectUri,
  recordRemoteStatusMentions,
  upsertRemoteStatus,
} from "./remote-status-store";
import { isTruthy, NoteDocumentSchema, stringList } from "./schemas";

const parseNoteDocument = schemaResult(NoteDocumentSchema);

const noteFromUnknown = (
  raw: unknown,
  actorUri: string,
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
  const id = StatusId.parse(newEntityId());
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
    language: { kind: "None" },
    publishedAt: publishedAt.value,
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
const recordMentions = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  statusId: string,
  notify: boolean,
): Promise<Result<void, RepositoryError>> => {
  const accountIds: string[] = [];
  for (const username of mentionedLocalUsernames(identity, raw)) {
    const account = await findAccountByUsername(env.DB, username);
    if (account.isOk() && account.value) {
      accountIds.push(account.value.id);
    }
  }
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

export const persistRemoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: string | Readonly<{ id: string } & Record<string, unknown>>,
  options: Readonly<{
    allowHosts?: ReadonlySet<string>;
    /** Notify the local accounts the note mentions, when it is newly stored (inbox `Create`). */
    notifyMentions?: boolean;
  }> = {},
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const objectUri = typeof object === "string" ? object : object.id;
  if (parseLocalStatusId(identity, objectUri)) {
    return ok(undefined);
  }
  const cached = await findRemoteStatusByObjectUri(env.DB, objectUri);
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (cached.value) {
    return ok(cached.value);
  }
  const raw =
    typeof object === "string" ? await fetchActivityJson(identity, object, options) : ok(object);
  if (raw.isErr()) {
    return ok(undefined);
  }
  const parsed = noteFromUnknown(raw.value, actor.actorUri);
  if (parsed.isErr()) {
    return parsed.error.kind === "RepositoryError" ? err(parsed.error) : ok(undefined);
  }
  // An admin block with `reject_media` keeps the post but not its attachments.
  const rejected = await mediaRejectedDomains(env.DB);
  const status = rejected.has(actor.domain.toLowerCase())
    ? { ...parsed.value, media: [] }
    : parsed.value;
  const note = parseNoteDocument(raw.value);
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
    raw.value,
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
