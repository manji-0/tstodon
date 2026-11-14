import {
  IsoInstant,
  type InstanceIdentity,
  type RemoteActor,
  type RemoteStatusValue,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { actorMovedTo, cacheFetchedActor, remoteActorFromDocument } from "./remote-actor-fetch";
import { setRemoteActorMovedTo } from "./remote-actor-store";
import { findMoveTarget } from "./remote-move";
import { contentChanged, isNewer, remoteRevisionStatement } from "./remote-status-edit";
import { settleInvalidRemoteStatus } from "./remote-status-heal";
import {
  applyMediaPolicy,
  noteFromUnknown,
  noteHashtags,
  parseNoteDocument,
} from "./remote-note-document";
import { finishRemoteNote, newlyMentionedAccountIds } from "./remote-status-persist";
import { listOwed, newOwedMarker, owedStatement } from "./remote-status-owed";
import { findDeliveredRemoteStatus, upsertRemoteStatus } from "./remote-status-store";

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
  if (object.value.type === "Note" || object.value.type === "Question") {
    return { kind: "NoteUpdate", objectUri: object.value.id, raw };
  }
  if (ACTOR_TYPES.has(object.value.type)) {
    return { kind: "ActorUpdate", raw };
  }
  return { kind: "Unsupported" };
};

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
  options: FederatedFetchOptions,
): Promise<Result<void, RepositoryError>> => {
  const cached = await findDeliveredRemoteStatus(env.DB, target.objectUri);
  if (cached.isErr()) {
    return cached.error.kind === "StoredRowInvalid"
      ? settleInvalidRemoteStatus(env, signer, cached.error, {
          activity: "Update",
          raw: target.raw,
        })
      : err(cached.error);
  }
  if (!cached.value || cached.value.actorUri !== signer.actorUri) {
    return ok(undefined);
  }
  const parsed = noteFromUnknown(target.raw, signer);
  if (parsed.isErr()) {
    return ok(undefined);
  }
  const note = parseNoteDocument(target.raw);
  if (note.isErr()) {
    return ok(undefined);
  }
  const editedAt = IsoInstant.parseRemote(note.value.updated ?? "").orElse(() =>
    IsoInstant.parse(nowIso()),
  );
  if (editedAt.isErr()) {
    return ok(undefined);
  }
  const refreshed = await applyMediaPolicy(env, signer, {
    ...parsed.value,
    id: cached.value.id,
    publishedAt: cached.value.publishedAt,
    visibility: cached.value.visibility,
    language: cached.value.language,
    editedAt: cached.value.editedAt,
  });
  const edited = contentChanged(cached.value, refreshed);
  // A late or replayed edit must not roll back a newer one. A count-only
  // refresh is not an edit and is always applied.
  const previous = cached.value.editedAt;
  if (edited && previous.kind === "Edited" && !isNewer(editedAt.value, previous.at)) {
    return ok(undefined);
  }
  const status: RemoteStatusValue = edited
    ? { ...refreshed, editedAt: { kind: "Edited", at: editedAt.value } }
    : refreshed;
  const added = await newlyMentionedAccountIds(env, identity, target.raw, cached.value.id);
  // An edit whose late steps failed left its marker. The sender's redelivery
  // carries content that is already stored, so it is not an edit, and
  // finishes that one's instead. A newer edit replaces the marker, and takes
  // over the mentions the failed one still owes a notification.
  const owed = await listOwed(env.DB, cached.value.id);
  if (owed.isErr()) {
    return err(owed.error);
  }
  const pending = owed.value.find((entry) => entry.kind === "Edited");
  // An edit owes its late steps until they finish.
  const marker = edited
    ? newOwedMarker("Edited", [...new Set([...added, ...(pending?.mentions ?? [])])])
    : undefined;
  const stored = await upsertRemoteStatus(
    env.DB,
    status,
    noteHashtags(target.raw),
    note.value.inReplyTo ?? undefined,
    { objectUri: target.objectUri, row: cached.value },
    // The version being replaced goes into the history with the row that
    // replaces it; the original is the first one kept.
    edited ? [remoteRevisionStatement(env.DB, cached.value)] : [],
    marker ? [(id) => owedStatement(env.DB, id, marker)] : [],
  );
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value === undefined) {
    return ok(undefined);
  }
  return finishRemoteNote(env, identity, {
    kind: "Updated",
    actor: signer,
    raw: target.raw,
    status: stored.value,
    options,
    added,
    edit: marker ?? pending,
  });
};

/**
 * Refresh the cached profile of the actor that signed the Update; nobody
 * else's. The handle stays as stored, without a WebFinger round trip, as
 * Mastodon's `Update` passes the account's own username and domain to
 * `ProcessAccountService`; the stale-actor refresh confirms it again. Its `movedTo` follows the document as Mastodon's account processing
 * does: a target that lists the signer in `alsoKnownAs` is recorded, a
 * document without one clears a recorded move (the redirect was cancelled).
 * Only a `Move` carries followers over.
 */
const applyActorUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  target: Extract<UpdateTarget, { kind: "ActorUpdate" }>,
  options: FederatedFetchOptions,
): Promise<Result<void, RepositoryError>> => {
  const refreshed = remoteActorFromDocument(target.raw, signer.actorUri);
  if (refreshed.isErr()) {
    return ok(undefined);
  }
  const stored = await cacheFetchedActor(env.DB, identity, refreshed.value, options, {
    kind: "KeepStored",
  });
  if (stored.isErr()) {
    return stored.error.kind === "DomainRefused" ? ok(undefined) : err(stored.error);
  }
  const movedTo = actorMovedTo(target.raw);
  if (movedTo === signer.movedTo) {
    return ok(undefined);
  }
  if (movedTo === undefined) {
    return setRemoteActorMovedTo(env.DB, signer.actorUri, null);
  }
  const destination = await findMoveTarget(env, identity, movedTo, options);
  if (destination.isErr()) {
    return err(destination.error);
  }
  if (!destination.value?.aliases.includes(signer.actorUri)) {
    return ok(undefined);
  }
  return setRemoteActorMovedTo(env.DB, signer.actorUri, destination.value.ref.actorUri);
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
  options: FederatedFetchOptions,
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
      return applyNoteUpdate(env, identity, signer, target, options);
    case "ActorUpdate":
      return applyActorUpdate(env, identity, signer, target, options);
    case "Unsupported":
      return ok(undefined);
  }
};
