import {
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  RealtimeWindow,
  type RemoteStatus as RemoteStatusValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { nowInstant } from "./clock";
import { type RepositoryError, runD1, toRepositoryError } from "./d1";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import {
  claimRemoteStatusThreadResolve,
  releaseRemoteStatusThreadResolve,
} from "./generated/prisma/sql";
import { instanceActorFetchSigner } from "./instance-actor";
import { parseNoteDocument } from "./remote-note-document";
import { findRemoteStatusReplyTargetByObjectUri } from "./remote-reply-store";
import { findStoredNote, redistributeRemoteNote, storeNoteDocument } from "./remote-status-persist";
import { findRemoteStatusById } from "./remote-status-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { queryTyped, runTyped } from "./typed-sql";

/**
 * Statuses one chain of thread jobs fetches, Mastodon's
 * `ActivityPub::FetchRemoteStatusService::DISCOVERIES_PER_REQUEST`: the
 * request id a reply's `ThreadResolveWorker` starts is passed to each
 * parent's `Create`, whose own `resolve_thread` passes it on, and a fetch
 * past this many under one request id stores nothing.
 */
export const THREAD_RESOLVE_HOP_LIMIT = 1000;

type ResolveRemoteThread = Extract<OutboxJobValue, { kind: "ResolveRemoteThread" }>;

const ClaimedRow = z.object({ in_reply_to_uri: z.string() });

/**
 * Whether a reply's `inReplyTo` names a status a job could fetch: an http(s)
 * URL, as Mastodon's `Request.valid_url?`, off this server.
 */
const fetchableParent = (identity: InstanceIdentity, uri: string): boolean => {
  const url = URL.parse(uri);
  return (
    url !== null &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin !== new URL(identity.publicOrigin).origin
  );
};

/**
 * Queue the thread job of the stored remote reply `statusId` when its parent
 * is not stored, as Mastodon's `Create#resolve_thread` queues
 * `ThreadResolveWorker`. `hop` is the job's place in its chain; past
 * {@link THREAD_RESOLVE_HOP_LIMIT} nothing is queued. A reply gets one job:
 * the claim is taken in the statement that checks the parent, and given back
 * only when the job could not be sent, so the caller's retry sends it.
 */
export const queueRemoteThreadResolve = async (
  env: Env,
  identity: InstanceIdentity,
  statusId: string,
  hop: number,
): Promise<Result<void, RepositoryError>> => {
  if (hop > THREAD_RESOLVE_HOP_LIMIT) {
    return ok(undefined);
  }
  const claimedAt = nowInstant();
  const claimed = await runD1(() =>
    queryTyped(env.DB, claimRemoteStatusThreadResolve(claimedAt, statusId), ClaimedRow),
  );
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  const parentUri = claimed.value[0]?.in_reply_to_uri;
  const job = OutboxJob.parse({ kind: "ResolveRemoteThread", statusId, hop });
  if (parentUri === undefined || !fetchableParent(identity, parentUri) || job.isErr()) {
    return ok(undefined);
  }
  try {
    // The pull queue, not the delivery queue: a chain's fetches must not hold up deliveries.
    await env.PULL_QUEUE.send(job.value);
    return ok(undefined);
  } catch (cause) {
    // Best effort: a claim kept here leaves the reply unlinked.
    await runD1(() => runTyped(env.DB, releaseRemoteStatusThreadResolve(statusId, claimedAt)));
    return err(
      toRepositoryError(
        `queueing the thread job failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }
};

/**
 * `Create#resolve_thread` for the note `status` an inbox activity stored
 * from `object`: its first thread job, when it replies to a status not
 * stored. A note sent inline that replies to nothing costs no statement.
 */
export const resolveDeliveredThread = (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  object: unknown,
): Promise<Result<void, RepositoryError>> => {
  const sent = typeof object === "string" ? undefined : parseNoteDocument(object);
  return sent?.isOk() && !sent.value.inReplyTo
    ? Promise.resolve(ok(undefined))
    : queueRemoteThreadResolve(env, identity, status.id, 1);
};

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
): Promise<ResolvedParent> => {
  const stored = await findStoredNote(env, identity, uri);
  if (stored.isErr()) {
    return { kind: "Retry" };
  }
  if (stored.value !== undefined) {
    return { kind: "Stored", statusId: stored.value.note?.id };
  }
  // As `FetchRemoteStatusService`: a server that cannot be reached raises and
  // the job is retried; any answer that is no note ends it.
  const raw = await fetchActivityJson(identity, uri, options);
  if (raw.isErr()) {
    return raw.error.kind === "VerificationUnavailable" ? { kind: "Retry" } : { kind: "Missing" };
  }
  const note = await storeNoteDocument(env, identity, uri, raw.value, {
    ...options,
    idClock: "Published",
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
  const parent = await resolveParent(env, identity.value, parentUri, options);
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
