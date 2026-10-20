import {
  IsoInstant,
  RemoteStatus,
  StatusId,
  type InstanceIdentity,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson } from "./federated-fetch";
import { newEntityId } from "./ids";
import { parseLocalStatusId } from "./activitypub";
import { mediaRejectedDomains } from "./admin-domain-block-store";
import { enqueueLinkCard } from "./link-card";
import { findRemoteStatusByObjectUri, upsertRemoteStatus } from "./remote-status-store";
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

export const persistRemoteObject = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  object: string | Readonly<{ id: string } & Record<string, unknown>>,
  options: Readonly<{ allowHosts?: ReadonlySet<string> }> = {},
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
  const stored = await upsertRemoteStatus(env.DB, status);
  if (stored.isOk()) {
    // Preview cards are built off the request path like for local posts.
    await enqueueLinkCard(env, "RemoteStatus", stored.value.id, stored.value.contentHtml);
  }
  return stored;
};
