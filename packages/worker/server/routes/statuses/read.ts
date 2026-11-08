import type { Context } from "hono";
import {
  type InstanceIdentity,
  type LocalStatus as LocalStatusValue,
  type ThreadStatus,
} from "@tstodon/domain";
import { authenticate } from "../../auth";
import { statusDocumentsByIds } from "../../status-documents";
import {
  findThreadParent,
  listThreadAncestors,
  listThreadDescendants,
  visibleThreadStatuses,
} from "../../thread-context";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../../http";
import { mastodonRemoteStatuses } from "../../remote-status-documents";
import { mastodonStatus, mastodonStatuses } from "../../local-status-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../../d1";
import { findRemoteStatusById, findRemoteStatusesByIds } from "../../remote-status-store";
import { requestRemoteThreadBackfill } from "../../remote-thread-backfill";
import { requestQuoteRefresh } from "../../quote-retry-queue";
import { ContextLimits, findStatusById, findStatusesByIds } from "../../status-store";
import { canViewRemoteBoost, canViewRemoteStatus, canViewStatus } from "../../visibility-guard";
import { findRemoteBoostById } from "../../remote-boost-store";
import { remoteBoostDocuments } from "../../remote-boost-documents";
import { documentsById } from "../../documents-by-id";
import { findShownStatusAnywhere } from "../../found-status";

/** A remote actor's boost, fetched by its id as Mastodon allows for reblogs. */
const visibleRemoteBoostDocument = async (
  env: Env,
  identity: InstanceIdentity,
  id: string,
  viewerId: string | undefined,
): Promise<Result<Record<string, unknown> | null, RepositoryError>> => {
  const boost = await findRemoteBoostById(env.DB, id);
  if (boost.isErr()) {
    return err(boost.error);
  }
  if (!boost.value || !(await canViewRemoteBoost(env.DB, boost.value, viewerId))) {
    return ok(null);
  }
  const documents = await remoteBoostDocuments(env, identity, [boost.value], viewerId);
  return documents.map((rendered) => rendered[0] ?? null);
};

const visibleStatusDocument = async (
  env: Env,
  identity: InstanceIdentity,
  id: string,
  viewerId: string | undefined,
): Promise<Result<Record<string, unknown> | null, RepositoryError>> => {
  const status = await findStatusById(env.DB, id);
  if (status.isErr()) {
    return err(status.error);
  }
  if (!status.value) {
    const remote = await findRemoteStatusById(env.DB, id);
    if (remote.isErr()) {
      return err(remote.error);
    }
    if (!remote.value) {
      return visibleRemoteBoostDocument(env, identity, id, viewerId);
    }
    if (!(await canViewRemoteStatus(env.DB, remote.value, viewerId))) {
      return ok(null);
    }
    return (await mastodonRemoteStatuses(env, identity, [remote.value], viewerId)).map(
      (documents) => documents[0] ?? null,
    );
  }
  if (!(await canViewStatus(env.DB, status.value, viewerId))) {
    return ok(null);
  }
  return (await mastodonStatus(env, identity, status.value, viewerId)).map(
    (document) => document ?? null,
  );
};

/** Mastodon caps `GET /api/v1/statuses?id[]=` at 20 ids. */
const MULTIPLE_STATUSES_LIMIT = 20;

export const getV1Statuses = async (c: Context<{ Bindings: Env }, "/api/v1/statuses">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const url = new URL(c.req.url);
  const ids = [
    ...new Set(
      [...url.searchParams.getAll("id[]"), ...url.searchParams.getAll("id")].filter(
        (id) => id.length > 0,
      ),
    ),
  ].slice(0, MULTIPLE_STATUSES_LIMIT);
  // Local and remote statuses each load in one query; missing or hidden ones
  // are left out rather than failing the batch.
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(c.env.DB, ids),
    findRemoteStatusesByIds(c.env.DB, ids),
  ]);
  if (locals.isErr()) {
    return jsonRepositoryError(c, locals.error.message);
  }
  if (remotes.isErr()) {
    return jsonRepositoryError(c, remotes.error.message);
  }
  // Public and unlisted statuses pass without a query; only restricted ones look further.
  const visibleLocals = (
    await Promise.all(
      [...locals.value.values()].map(async (status) =>
        (await canViewStatus(c.env.DB, status, viewerId)) ? [status] : [],
      ),
    )
  ).flat();
  const visibleRemotes = (
    await Promise.all(
      [...remotes.value.values()].map(async (status) =>
        (await canViewRemoteStatus(c.env.DB, status, viewerId)) ? [status] : [],
      ),
    )
  ).flat();
  const [localDocuments, remoteDocuments] = await Promise.all([
    mastodonStatuses(c.env, identity.value, visibleLocals, viewerId),
    mastodonRemoteStatuses(c.env, identity.value, visibleRemotes, viewerId),
  ]);
  if (localDocuments.isErr()) {
    return jsonRepositoryError(c, localDocuments.error.message);
  }
  if (remoteDocuments.isErr()) {
    return jsonRepositoryError(c, remoteDocuments.error.message);
  }
  const documents = documentsById([...localDocuments.value, ...remoteDocuments.value]);
  return c.json(ids.flatMap((id) => documents.get(id) ?? []));
};

export const getV1StatusesById = async (c: Context<{ Bindings: Env }, "/api/v1/statuses/:id">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const document = await visibleStatusDocument(c.env, identity.value, c.req.param("id"), viewerId);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  if (!document.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  // As Mastodon's `show`, a stale quote's stamp is checked again, off the request path.
  await requestQuoteRefresh(c.env, c.req.param("id"));
  return c.json(document.value);
};

export const getV1StatusesByIdContext = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/context">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  // The thread of a local status or a cached remote one, across both.
  const found = await findShownStatusAnywhere(c.env, c.req.param("id"), viewerId);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const start: ThreadStatus =
    found.value.kind === "LocalStatus"
      ? { kind: "Local", status: found.value.status }
      : { kind: "Remote", status: found.value.status };
  if (start.kind === "Remote") {
    await requestRemoteThreadBackfill(c.env, start.status);
  }
  const limits = viewerId ? ContextLimits.authenticated : ContextLimits.anonymous;
  const ancestors = await listThreadAncestors(
    (status) => findThreadParent(c.env.DB, identity.value, status),
    start,
    limits.depth,
  );
  if (ancestors.isErr()) {
    return jsonRepositoryError(c, ancestors.error.message);
  }
  const descendants = await listThreadDescendants(
    c.env.DB,
    identity.value,
    start,
    limits.descendants,
    limits.depth,
  );
  if (descendants.isErr()) {
    return jsonRepositoryError(c, descendants.error.message);
  }
  const visibleAncestors = await visibleThreadStatuses(c.env.DB, ancestors.value, viewerId);
  const visibleDescendants = await visibleThreadStatuses(c.env.DB, descendants.value, viewerId);
  const documents = await statusDocumentsByIds(
    c.env,
    identity.value,
    [...visibleAncestors, ...visibleDescendants].map((node) => node.status.id),
    viewerId,
  );
  if (documents.isErr()) {
    return jsonRepositoryError(c, documents.error.message);
  }
  const render = (nodes: ReadonlyArray<ThreadStatus>) =>
    nodes.flatMap((node) => documents.value.get(node.status.id) ?? []);
  return c.json({
    ancestors: render(visibleAncestors),
    descendants: render(visibleDescendants),
  });
};

export const postV1StatusesByIdTranslate = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/translate">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const status = await findStatusById(c.env.DB, c.req.param("id") ?? "");
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  let translatable: LocalStatusValue | undefined;
  if (status.value.kind === "LocalNote") {
    translatable = status.value;
  } else {
    const target = await findStatusById(c.env.DB, status.value.target.statusId);
    if (target.isErr()) {
      return jsonRepositoryError(c, target.error.message);
    }
    translatable = target.value;
  }
  const visibility = translatable?.kind === "LocalNote" ? translatable.visibility.kind : undefined;
  if (visibility !== "Public" && visibility !== "Unlisted") {
    return c.json({ error: "This action is not allowed", kind: "Forbidden" }, 403);
  }
  return c.json({ error: "Service Unavailable", kind: "TranslationUnavailable" }, 503);
};
