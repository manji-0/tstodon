import { IsoInstant, type InstanceIdentity, type RemoteActor } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { enqueueLinkCard } from "./link-card";
import { isAccountMentionedOnRemoteStatus, recordRemoteStatusMentions } from "./mention-store";
import { notifyFromRemote } from "./notify";
import { remoteActorFromDocument } from "./remote-actor-fetch";
import { upsertRemoteActor } from "./remote-actor-store";
import {
  applyMediaPolicy,
  mentionedLocalAccountIds,
  noteFromUnknown,
  parseNoteDocument,
} from "./remote-status-persist";
import { findRemoteStatusByObjectUri, upsertRemoteStatus } from "./remote-status-store";

const UpdateObjectSchema = z
  .object({ id: z.string().min(1), type: z.string().min(1) })
  .passthrough();

const parseUpdateObject = schemaResult(UpdateObjectSchema);

const ACTOR_TYPES: ReadonlySet<string> = new Set([
  "Person",
  "Service",
  "Application",
  "Group",
  "Organization",
]);

/** What an inbox `Update` carries, as far as this server acts on it. */
export type UpdateTarget =
  | Readonly<{ kind: "NoteUpdate"; objectUri: string; raw: unknown }>
  | Readonly<{ kind: "ActorUpdate"; raw: unknown }>
  | Readonly<{ kind: "Unsupported" }>;

export const classifyUpdateObject = (raw: unknown): UpdateTarget => {
  const object = parseUpdateObject(raw);
  if (object.isErr()) {
    return { kind: "Unsupported" };
  }
  if (object.value.type === "Note") {
    return { kind: "NoteUpdate", objectUri: object.value.id, raw };
  }
  if (ACTOR_TYPES.has(object.value.type)) {
    return { kind: "ActorUpdate", raw };
  }
  return { kind: "Unsupported" };
};

const isNewer = (candidate: string, than: string): boolean =>
  Date.parse(candidate) > Date.parse(than);

/**
 * Apply an edit to a note that is already cached. Like Mastodon, an Update
 * for a status this server never stored is ignored, and so is one for a note
 * the signer did not write.
 */
const applyNoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  target: Extract<UpdateTarget, { kind: "NoteUpdate" }>,
): Promise<Result<void, RepositoryError>> => {
  const cached = await findRemoteStatusByObjectUri(env.DB, target.objectUri);
  if (cached.isErr()) {
    return err(cached.error);
  }
  if (!cached.value || cached.value.actorUri !== signer.actorUri) {
    return ok(undefined);
  }
  const parsed = noteFromUnknown(target.raw, signer.actorUri);
  if (parsed.isErr()) {
    return parsed.error.kind === "RepositoryError" ? err(parsed.error) : ok(undefined);
  }
  const note = parseNoteDocument(target.raw);
  if (note.isErr()) {
    return ok(undefined);
  }
  const editedAt = IsoInstant.parse(note.value.updated ?? "").orElse(() =>
    IsoInstant.parse(nowIso()),
  );
  if (editedAt.isErr()) {
    return ok(undefined);
  }
  // A late or replayed Update must not roll back a newer edit.
  const previous = cached.value.editedAt;
  if (previous.kind === "Edited" && !isNewer(editedAt.value, previous.at)) {
    return ok(undefined);
  }
  const status = await applyMediaPolicy(env, signer, {
    ...parsed.value,
    id: cached.value.id,
    publishedAt: cached.value.publishedAt,
    visibility: cached.value.visibility,
    language: cached.value.language,
    editedAt: { kind: "Edited", at: editedAt.value },
  });
  const stored = await upsertRemoteStatus(env.DB, status, note.value.inReplyTo ?? undefined);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const mentioned = await mentionedLocalAccountIds(env, identity, target.raw);
  const added: string[] = [];
  for (const accountId of mentioned) {
    const already = await isAccountMentionedOnRemoteStatus(env.DB, stored.value.id, accountId);
    if (already.isOk() && !already.value) {
      added.push(accountId);
    }
  }
  const recorded = await recordRemoteStatusMentions(env.DB, stored.value.id, mentioned);
  if (recorded.isErr()) {
    return err(recorded.error);
  }
  for (const accountId of added) {
    await notifyFromRemote(env, {
      accountId,
      actorUri: signer.actorUri,
      kind: "mention",
      statusId: stored.value.id,
    });
  }
  await enqueueLinkCard(env, "RemoteStatus", stored.value.id, stored.value.contentHtml);
  return ok(undefined);
};

/** Refresh the cached profile of the actor that signed the Update; nobody else's. */
const applyActorUpdate = async (
  env: Env,
  signer: RemoteActor,
  target: Extract<UpdateTarget, { kind: "ActorUpdate" }>,
): Promise<Result<void, RepositoryError>> => {
  const refreshed = remoteActorFromDocument(target.raw, signer.actorUri);
  if (refreshed.isErr()) {
    return ok(undefined);
  }
  const stored = await upsertRemoteActor(env.DB, refreshed.value);
  return stored.isErr() ? err(stored.error) : ok(undefined);
};

/**
 * Handle an inbox `Update` from a signature-verified remote actor. `object`
 * is the activity's object, embedded or a bare URI that is fetched.
 */
export const applyRemoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  object: string | Readonly<Record<string, unknown>>,
  options: FederatedFetchOptions = {},
): Promise<Result<void, RepositoryError>> => {
  let raw: unknown = object;
  if (typeof object === "string") {
    const fetched = await fetchActivityJson(identity, object, options);
    if (fetched.isErr()) {
      return ok(undefined);
    }
    // The document has to be the object that was named, not one it redirects to.
    const named = parseUpdateObject(fetched.value);
    if (named.isErr() || named.value.id !== object) {
      return ok(undefined);
    }
    raw = fetched.value;
  }
  const target = classifyUpdateObject(raw);
  switch (target.kind) {
    case "NoteUpdate":
      return applyNoteUpdate(env, identity, signer, target);
    case "ActorUpdate":
      return applyActorUpdate(env, signer, target);
    case "Unsupported":
      return ok(undefined);
  }
};
