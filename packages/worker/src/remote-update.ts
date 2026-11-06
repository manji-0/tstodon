import {
  IsoInstant,
  RemotePoll,
  StatusTarget,
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
import { enqueueHomeFanOut } from "./home-fan-out";
import { enqueuePublicFanOut } from "./public-fan-out";
import { enqueueLinkCard } from "./link-card";
import { isAccountMentionedOnRemoteStatus, recordRemoteStatusMentions } from "./mention-store";
import { notifyFromRemote } from "./notify";
import { actorMovedTo, cacheFetchedActor, remoteActorFromDocument } from "./remote-actor-fetch";
import { setRemoteActorMovedTo } from "./remote-actor-store";
import { findMoveTarget } from "./remote-move";
import { snapshotRemoteRevision } from "./remote-status-edit";
import {
  applyMediaPolicy,
  mentionedLocalAccountIds,
  remoteMentionedPost,
  noteFromUnknown,
  parseNoteDocument,
} from "./remote-status-persist";
import { syncRemoteQuote } from "./remote-quote";
import { listLocalBoosterAccountIds } from "./status-interaction-store";
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
  if (object.value.type === "Note" || object.value.type === "Question") {
    return { kind: "NoteUpdate", objectUri: object.value.id, raw };
  }
  if (ACTOR_TYPES.has(object.value.type)) {
    return { kind: "ActorUpdate", raw };
  }
  return { kind: "Unsupported" };
};

/**
 * Whether the author changed what the post says. Vote counts, which a
 * `Question` refreshes as people vote, are not an edit, as on Mastodon.
 */
const contentChanged = (before: RemoteStatusValue, after: RemoteStatusValue): boolean =>
  before.contentHtml !== after.contentHtml ||
  before.spoilerText !== after.spoilerText ||
  before.sensitive !== after.sensitive ||
  JSON.stringify(before.media) !== JSON.stringify(after.media) ||
  !RemotePoll.sameQuestion(before.poll, after.poll);

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
  if (edited) {
    // The version being replaced goes into the history first; the original is the first one kept.
    const kept = await snapshotRemoteRevision(env.DB, cached.value);
    if (kept.isErr()) {
      return err(kept.error);
    }
  }
  const status: RemoteStatusValue = edited
    ? { ...refreshed, editedAt: { kind: "Edited", at: editedAt.value } }
    : refreshed;
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
  const quote = await syncRemoteQuote(env.DB, identity, stored.value, target.raw);
  if (quote.isErr()) {
    return err(quote.error);
  }
  if (added.length > 0) {
    const post = await remoteMentionedPost(env.DB, identity, target.raw, stored.value, mentioned);
    for (const accountId of added) {
      await notifyFromRemote(
        env,
        { accountId, actorUri: signer.actorUri, kind: "mention", statusId: stored.value.id },
        post,
      );
    }
  }
  await enqueueLinkCard(env, "RemoteStatus", stored.value.id, stored.value.contentHtml);
  if (edited) {
    // As Mastodon's UpdateStatusService: local accounts that boosted the note hear it changed.
    // Quotes are skipped: a local account cannot yet quote a remote status.
    const boosters = await listLocalBoosterAccountIds(env.DB, StatusTarget.remote(stored.value.id));
    for (const accountId of boosters.isOk() ? boosters.value : []) {
      await notifyFromRemote(env, {
        accountId,
        actorUri: signer.actorUri,
        kind: "update",
        statusId: stored.value.id,
      });
    }
    await enqueueHomeFanOut(env, {
      event: "status.update",
      entryId: stored.value.id,
      author: { kind: "RemoteActor", actorUri: signer.actorUri },
    });
    if (stored.value.visibility.kind === "Public") {
      await enqueuePublicFanOut(env, { event: "status.update", entryId: stored.value.id });
    }
  }
  return ok(undefined);
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
      return applyActorUpdate(env, identity, signer, target, options);
    case "Unsupported":
      return ok(undefined);
  }
};
