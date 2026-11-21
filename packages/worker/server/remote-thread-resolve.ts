import { type InstanceIdentity, OutboxJob } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowInstant } from "./clock";
import { type RepositoryError, runD1, toRepositoryError } from "./d1";
import {
  claimRemoteStatusThreadResolve,
  releaseRemoteStatusThreadResolve,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

/**
 * Statuses one chain of thread jobs fetches, Mastodon's
 * `ActivityPub::FetchRemoteStatusService::DISCOVERIES_PER_REQUEST`: the
 * request id a reply's `ThreadResolveWorker` starts is passed to each
 * parent's `Create`, whose own `resolve_thread` passes it on, and a fetch
 * past this many under one request id stores nothing.
 */
export const THREAD_RESOLVE_HOP_LIMIT = 1000;

/**
 * How long a reply's claim on its thread job holds. A job is sent right after
 * its claim, and a failed send gives the claim back; one that is still held
 * after this lost its job (the invocation died between the two), so the next
 * `Create` of the reply queues it again.
 */
export const THREAD_RESOLVE_CLAIM_TTL_MS = 60 * 60 * 1000;

const ClaimedRow = z.object({ in_reply_to_uri: z.string() });

/**
 * Whether a reply's `inReplyTo` names a status a job could fetch: an http(s)
 * URL, as Mastodon's `Request.valid_url?`, off this server.
 */
export const fetchableParent = (identity: InstanceIdentity, uri: string): boolean => {
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
 * `ThreadResolveWorker`, on the pull queue, which keeps a chain's fetches off
 * the delivery queue. `hop` is the job's place in its chain; past
 * {@link THREAD_RESOLVE_HOP_LIMIT} nothing is queued. A reply gets one job:
 * the claim is taken in the statement that checks the parent, and given back
 * when the job could not be sent, so the caller's retry sends it.
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
  const staleBefore = new Date(Date.parse(claimedAt) - THREAD_RESOLVE_CLAIM_TTL_MS).toISOString();
  const claimed = await runD1(() =>
    queryTyped(
      env.DB,
      claimRemoteStatusThreadResolve(claimedAt, statusId, staleBefore),
      ClaimedRow,
    ),
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
    await env.PULL_QUEUE.send(job.value);
    return ok(undefined);
  } catch (cause) {
    // Best effort: a claim kept here expires after THREAD_RESOLVE_CLAIM_TTL_MS.
    await runD1(() => runTyped(env.DB, releaseRemoteStatusThreadResolve(statusId, claimedAt)));
    return err(
      toRepositoryError(
        `queueing the thread job failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }
};
