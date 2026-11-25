import type { Context } from "hono";
import { findAccountById } from "../account-store";
import { acceptRemoteFollowRequest } from "../follow-request-approval";
import {
  jsonAuthError,
  jsonRepositoryError,
  queryLimit,
  queryCursor,
  requireUser,
  setPaginationLinks,
  PageSize,
} from "../http";
import { availableAccountDocumentsByIds, documentsInOrder } from "../account-documents";
import { mastodonRelationship } from "../relationship-document";
import {
  findPendingRemoteFollowRequest,
  findRemoteActorByUri,
  rejectRemoteFollowRequest,
} from "../remote-actor-store";
import { sendFollowReject } from "../remote-follower";
import { parseInstanceIdentity } from "../runtime-config";
import { RemoteAccountId } from "../remote-account-id";
import { authorizeFollowRequest, listFollowRequests, rejectFollowRequest } from "../follow-store";
import { relationshipFlags } from "../relationship-store";

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** Resolve a follow request target id to a local account or a remote actor uri. */
const localRequester = async (c: Context<{ Bindings: Env }>, id: string) => {
  const account = await findAccountById(c.env.DB, id);
  if (account.isErr()) {
    return { kind: "error" as const, message: account.error.message };
  }
  return { kind: "local" as const, account: account.value };
};

/** Resolve a path id to a remote actor via the reversible `r_` account id. */
const remoteRequester = async (c: Context<{ Bindings: Env }>, id: string) => {
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isErr()) {
    return { kind: "notFound" as const };
  }
  const actor = await findRemoteActorByUri(c.env.DB, actorUri.value);
  if (actor.isErr()) {
    return { kind: "error" as const, message: actor.error.message };
  }
  if (!actor.value) {
    return { kind: "notFound" as const };
  }
  return { kind: "remote" as const, actor: actor.value, actorUri: actorUri.value };
};

export const getV1FollowRequests = async (
  c: Context<{ Bindings: Env }, "/api/v1/follow_requests">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryLimit(c, PageSize.accounts);
  const requests = await listFollowRequests(c.env.DB, user.value.id, limit, queryCursor(c));
  if (requests.isErr()) {
    return jsonRepositoryError(c, requests.error.message);
  }
  const accountIds = requests.value.map((request) => request.accountId);
  const documents = await availableAccountDocumentsByIds(
    c.env,
    identity.value,
    user.value.id,
    accountIds,
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  // Follow row ids are not in the documents, so the Link header carries them.
  setPaginationLinks(
    c,
    requests.value.map((request) => request.id),
    limit,
    { prev: "since_id" },
  );
  return c.json(documentsInOrder(accountIds, documents.value));
};

export const postV1FollowRequestsByIdAuthorize = async (
  c: Context<{ Bindings: Env }, "/api/v1/follow_requests/:id/authorize">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";

  const local = await localRequester(c, id);
  if (local.kind === "error") {
    return jsonRepositoryError(c, local.message);
  }
  if (local.account) {
    const authorized = await authorizeFollowRequest(c.env.DB, user.value.id, local.account.id);
    if (authorized.isErr()) {
      return jsonRepositoryError(c, authorized.error.message);
    }
    if (!authorized.value) {
      return notFound(c);
    }
    const flags = await relationshipFlags(c.env.DB, user.value.id, local.account.id);
    if (flags.isErr()) {
      return jsonRepositoryError(c, flags.error.message);
    }
    return c.json(mastodonRelationship(local.account.id, flags.value));
  }

  const remote = await remoteRequester(c, id);
  if (remote.kind === "notFound") {
    return notFound(c);
  }
  if (remote.kind === "error") {
    return jsonRepositoryError(c, remote.message);
  }
  const authorized = await acceptRemoteFollowRequest(
    c.env,
    identity.value,
    user.value,
    remote.actor,
  );
  if (authorized.isErr()) {
    return jsonRepositoryError(c, authorized.error.message);
  }
  if (!authorized.value) {
    return notFound(c);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, id);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(id, flags.value));
};

export const postV1FollowRequestsByIdReject = async (
  c: Context<{ Bindings: Env }, "/api/v1/follow_requests/:id/reject">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const id = c.req.param("id") ?? "";

  const local = await localRequester(c, id);
  if (local.kind === "error") {
    return jsonRepositoryError(c, local.message);
  }
  if (local.account) {
    const rejected = await rejectFollowRequest(c.env.DB, user.value.id, local.account.id);
    if (rejected.isErr()) {
      return jsonRepositoryError(c, rejected.error.message);
    }
    if (!rejected.value) {
      return notFound(c);
    }
    const flags = await relationshipFlags(c.env.DB, user.value.id, local.account.id);
    if (flags.isErr()) {
      return jsonRepositoryError(c, flags.error.message);
    }
    return c.json(mastodonRelationship(local.account.id, flags.value));
  }

  const remote = await remoteRequester(c, id);
  if (remote.kind === "notFound") {
    return notFound(c);
  }
  if (remote.kind === "error") {
    return jsonRepositoryError(c, remote.message);
  }
  const followActivityId = await findPendingRemoteFollowRequest(
    c.env.DB,
    user.value.id,
    remote.actorUri,
  );
  if (followActivityId.isErr()) {
    return jsonRepositoryError(c, followActivityId.error.message);
  }
  const rejected = await rejectRemoteFollowRequest(c.env.DB, user.value.id, remote.actorUri);
  if (rejected.isErr()) {
    return jsonRepositoryError(c, rejected.error.message);
  }
  if (!rejected.value) {
    return notFound(c);
  }
  if (followActivityId.value) {
    await sendFollowReject(c.env, identity.value, user.value, remote.actor, followActivityId.value);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, id);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(id, flags.value));
};
