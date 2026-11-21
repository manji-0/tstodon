import {
  type InstanceIdentity,
  type OutboxJob as OutboxJobValue,
  RealtimeWindow,
} from "@tstodon/domain";
import { suspendedDomains } from "./admin-domain-block-store";
import { nowInstant } from "./clock";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { instanceActorFetchSigner } from "./instance-actor";
import { findRemoteStatusReplyTargetByObjectUri } from "./remote-reply-store";
import { findStoredNote, redistributeRemoteNote, storeNoteDocument } from "./remote-status-persist";
import { findRemoteStatusById } from "./remote-status-store";
import { fetchableParent, queueRemoteThreadResolve } from "./remote-thread-resolve";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

type ResolveRemoteThread = Extract<OutboxJobValue, { kind: "ResolveRemoteThread" }>;

/** The note `uri` names, stored, or fetched and stored now. */
type ResolvedParent =
  | Readonly<{ kind: "Retry" }>
  | Readonly<{ kind: "Missing" }>
  | Readonly<{ kind: "Stored"; statusId: string | undefined }>;

const resolveParent = async (
  env: Env,
  identity: InstanceIdentity,
  uri: string,
  options: FederatedFetchOptions,
  hop: number,
): Promise<ResolvedParent> => {
  const stored = await findStoredNote(env, identity, uri);
  if (stored.isErr()) {
    return { kind: "Retry" };
  }
  if (stored.value !== undefined) {
    return { kind: "Stored", statusId: stored.value.note?.id };
  }
  // As `FetchRemoteStatusService`: a server that cannot be reached, or does
  // not answer in time, raises and the job is retried; any answer that is no
  // note, a 5xx included, ends it.
  const raw = await fetchActivityJson(identity, uri, options);
  if (raw.isErr()) {
    return raw.error.kind === "VerificationUnavailable" && raw.error.status === undefined
      ? { kind: "Retry" }
      : { kind: "Missing" };
  }
  const note = await storeNoteDocument(env, identity, uri, raw.value, {
    ...options,
    idClock: "Published",
    thread: { kind: "Queue", hop },
    fanOut: "Queued",
  });
  if (note.isErr()) {
    return { kind: "Retry" };
  }
  return note.value === undefined
    ? { kind: "Missing" }
    : { kind: "Stored", statusId: note.value.id };
};

/**
 * `ResolveRemoteThread`, Mastodon's `ThreadResolveWorker`: store the parent
 * of the reply, which links the reply to it (tstodon links by `inReplyTo`),
 * queue the parent's own job when its parent is not stored either, and
 * distribute the reply again when it was published within the real-time
 * window. Every step reads what is stored, so a retried or redelivered job
 * fetches nothing twice and notifies once.
 */
export const processResolveRemoteThreadJob = async (
  env: Env,
  job: ResolveRemoteThread,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const reply = await findRemoteStatusById(env.DB, job.statusId);
  if (reply.isErr()) {
    return "retry";
  }
  if (reply.value === undefined) {
    return "ok";
  }
  const target = await findRemoteStatusReplyTargetByObjectUri(env.DB, reply.value.objectUri);
  if (target.isErr()) {
    return "retry";
  }
  const parentUri = target.value?.inReplyToUri;
  if (parentUri === undefined || !fetchableParent(identity.value, parentUri)) {
    return "ok";
  }
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
    fetchSigner: instanceActorFetchSigner(env.DB, identity.value),
  };
  const parent = await resolveParent(env, identity.value, parentUri, options, job.hop + 1);
  switch (parent.kind) {
    case "Retry":
      return "retry";
    case "Missing":
      return "ok";
    case "Stored":
      break;
  }
  if (parent.statusId !== undefined) {
    const chained = await queueRemoteThreadResolve(
      env,
      identity.value,
      parent.statusId,
      job.hop + 1,
    );
    if (chained.isErr()) {
      return "retry";
    }
  }
  if (!RealtimeWindow.contains(reply.value.publishedAt, nowInstant())) {
    return "ok";
  }
  const distributed = await redistributeRemoteNote(env, identity.value, reply.value);
  return distributed.isOk() ? "ok" : "retry";
};
