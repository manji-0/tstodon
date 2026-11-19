import {
  Hostname,
  IsoInstant,
  type InstanceIdentity,
  type RemoteActor,
  type RemoteStatusValue,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { isStatusObjectType } from "./activitypub-wire";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import type { ReceivedActivity } from "./activity-forward";
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
import { applyRemoteCreate } from "./inbox/create";
import {
  finishRemoteNote,
  newlyMentionedAccountIds,
  persistRemoteObject,
} from "./remote-status-persist";
import { claimOwed, listOwed, newOwedMarker, owedStatement } from "./remote-status-owed";
import { findDeliveredRemoteStatus, upsertRemoteStatus } from "./remote-status-store";

/** Fetch options, and the activity as received, which a note it stores or edits forwards. */
type ForwardingFetchOptions = FederatedFetchOptions & Readonly<{ forward?: ReceivedActivity }>;

const UpdateObjectSchema = z
  .object({ id: z.string().min(1), type: z.union([z.string().min(1), z.array(z.string())]) })
  .passthrough();

const parseUpdateObject = schemaResult(UpdateObjectSchema);

type UpdateObject = z.infer<typeof UpdateObjectSchema>;

/**
 * How long ago a note this server never stored may have been published for
 * its `Update` to be applied, as Mastodon's `Update::OBJECT_AGE_THRESHOLD`.
 */
const UNKNOWN_NOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the note `raw` was published longer ago than
 * {@link UNKNOWN_NOTE_MAX_AGE_MS}, as Mastodon's `object_too_old?`: it reads
 * `published` only, not `updated`, and a document whose `published` does not
 * read as an instant is not too old.
 */
const publishedTooLongAgo = (raw: unknown, now: number): boolean => {
  const note = parseNoteDocument(raw);
  if (note.isErr()) {
    return false;
  }
  const published = IsoInstant.parseRemote(note.value.published);
  return published.isOk() && Date.parse(published.value) < now - UNKNOWN_NOTE_MAX_AGE_MS;
};

const ACTOR_TYPES: ReadonlySet<string> = new Set([
  "Person",
  "Service",
  "Application",
  "Group",
  "Organization",
]);

/** What an inbox `Update` carries, as far as this server acts on it. */
export type UpdateTarget =
  | Readonly<{ kind: "NoteUpdate"; objectUri: string; raw: UpdateObject }>
  | Readonly<{ kind: "ActorUpdate"; raw: unknown }>
  | Readonly<{ kind: "Unsupported" }>;

export const classifyUpdateObject = (raw: unknown): UpdateTarget => {
  const object = parseUpdateObject(raw);
  if (object.isErr()) {
    return { kind: "Unsupported" };
  }
  if (isStatusObjectType(object.value.type)) {
    return { kind: "NoteUpdate", objectUri: object.value.id, raw: object.value };
  }
  const types = typeof object.value.type === "string" ? [object.value.type] : object.value.type;
  if (types.some((type) => ACTOR_TYPES.has(type))) {
    return { kind: "ActorUpdate", raw };
  }
  return { kind: "Unsupported" };
};

/**
 * Apply an `Update` of a note, as Mastodon's `Update#update_status`. A note
 * on another host than the signer's is ignored, and so is one cached under
 * another author. A note this server never stored is handled as its `Create`
 * (the two can arrive out of order), unless it was published more than a day
 * ago. Mastodon also ignores one from a suspended author; here the inbox
 * refuses every activity of a suspended actor before it gets this far.
 */
const applyNoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  target: Extract<UpdateTarget, { kind: "NoteUpdate" }>,
  options: ForwardingFetchOptions,
): Promise<Result<void, RepositoryError>> => {
  if (Hostname.ofUri(target.objectUri) !== Hostname.ofUri(signer.actorUri)) {
    return ok(undefined);
  }
  const cached = await findDeliveredRemoteStatus(env.DB, target.objectUri);
  if (cached.isErr()) {
    if (cached.error.kind !== "StoredRowInvalid") {
      return err(cached.error);
    }
    const settled = await settleInvalidRemoteStatus(env, signer, cached.error, {
      activity: "Update",
      raw: target.raw,
    });
    return settled.map(() => undefined);
  }
  if (!cached.value) {
    return publishedTooLongAgo(target.raw, Date.now())
      ? ok(undefined)
      : applyRemoteCreate(env, identity, signer, target.raw, options, {
          objectUri: target.objectUri,
          row: undefined,
        });
  }
  if (cached.value.actorUri !== signer.actorUri) {
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
  const previous = cached.value.editedAt;
  // As Mastodon's `ProcessStatusUpdateService#handle_explicit_update!`, an
  // Update dated later than the stored edit takes the note's language, even
  // when the text stays the same.
  const explicit =
    note.value.updated != null &&
    (previous.kind !== "Edited" || isNewer(editedAt.value, previous.at));
  const refreshed = await applyMediaPolicy(env, signer, {
    ...parsed.value,
    id: cached.value.id,
    publishedAt: cached.value.publishedAt,
    visibility: cached.value.visibility,
    language: explicit ? parsed.value.language : cached.value.language,
    editedAt: cached.value.editedAt,
  });
  const edited = contentChanged(cached.value, refreshed);
  // A late or replayed edit must not roll back a newer one. A count-only
  // refresh is not an edit and is always applied.
  if (edited && previous.kind === "Edited" && !isNewer(editedAt.value, previous.at)) {
    return ok(undefined);
  }
  const status: RemoteStatusValue = edited
    ? { ...refreshed, editedAt: { kind: "Edited", at: editedAt.value } }
    : refreshed;
  const added = await newlyMentionedAccountIds(env, identity, target.raw, cached.value.id);
  if (added.isErr()) {
    return err(added.error);
  }
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
    ? newOwedMarker("Edited", [...new Set([...added.value, ...(pending?.mentions ?? [])])])
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
  // A note stored from a `Create`, or from an `Update` handled as one, whose
  // late steps failed left its marker. A delivery that edits nothing, with no
  // edit pending, finishes them as a redelivered `Create` does, once the
  // counts it carries are stored; `resumeCreated` runs them only from the
  // version the row holds.
  if (!edited && pending === undefined && owed.value.some((entry) => entry.kind === "Created")) {
    const finished = await persistRemoteObject(
      env,
      identity,
      signer,
      target.raw,
      { ...options, delivery: "Create" },
      { objectUri: target.objectUri, row: stored.value },
    );
    return finished.map(() => undefined);
  }
  // A pending edit is finished by one delivery at a time. When another holds
  // it, this `Update` runs the steps of its own document only and is done:
  // the edit is that delivery's, which answers its own sender.
  const resumed =
    marker === undefined && pending !== undefined
      ? await claimOwed(env.DB, stored.value.id, pending)
      : ok(undefined);
  if (resumed.isErr()) {
    return err(resumed.error);
  }
  return finishRemoteNote(env, identity, {
    kind: "Updated",
    actor: signer,
    raw: target.raw,
    status: stored.value,
    options,
    added: added.value,
    edit: marker ?? resumed.value,
  });
};

/**
 * Refresh the cached profile of the actor that signed the Update; nobody
 * else's. The handle stays as stored, without a WebFinger round trip, as
 * Mastodon's `Update` passes the account's own username and domain to
 * `ProcessAccountService`; the stale-actor refresh confirms it again. A
 * username Mastodon's `Account` would refuse is taken while it is the one
 * stored, as Mastodon validates it only when it changes. Its `movedTo`
 * follows the document as Mastodon's account processing
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
  const refreshed = remoteActorFromDocument(target.raw, signer.actorUri, signer.username);
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
  options: ForwardingFetchOptions,
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
