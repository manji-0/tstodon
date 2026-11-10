import type { Context } from "hono";
import { ApiMuteAccountParamsSchema } from "@tstodon/api";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  queryCursor,
  requireUser,
  setPaginationLinks,
} from "../../http";
import { mastodonRelationship } from "../../relationship-document";
import { availableAccountDocumentsByIds } from "../../account-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { blockAccountTarget, unblockAccountTarget } from "../../account-block";
import {
  listBlockedAccounts,
  listMutedAccounts,
  muteAccount,
  unmuteAccount,
} from "../../block-mute-store";
import { relationshipFlags } from "../../relationship-store";
import { readOptionalParams } from "../../request-params";
import { relationshipTarget } from "./endorsements";

const selfTargetError = (c: Context<{ Bindings: Env }>, action: string) =>
  c.json({ error: `Cannot ${action} yourself`, kind: "InvalidRelationship" }, 400);

/** Load the viewer's relationship with a local target and respond with it. */
const respondWithRelationship = async (
  c: Context<{ Bindings: Env }>,
  viewerId: string,
  targetId: string,
): Promise<Response> => {
  const flags = await relationshipFlags(c.env.DB, viewerId, targetId);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
};

const blockOrUnblock = async (c: Context<{ Bindings: Env }>, block: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";
  const target = await relationshipTarget(c, identity.value, targetId);
  if (!target) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.accountId === user.value.id) {
    return selfTargetError(c, block ? "block" : "unblock");
  }
  const written = block
    ? await blockAccountTarget(c.env, identity.value, user.value, target)
    : await unblockAccountTarget(c.env, identity.value, user.value, target);
  if (written.isErr()) {
    return jsonRepositoryError(c, written.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.accountId ?? targetId);
};

export const postV1AccountsByIdBlock = (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/block">,
) => blockOrUnblock(c, true);
export const postV1AccountsByIdUnblock = (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/unblock">,
) => blockOrUnblock(c, false);

export const postV1AccountsByIdMute = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/mute">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";
  const target = await relationshipTarget(c, identity.value, targetId);
  if (!target) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.accountId === user.value.id) {
    return selfTargetError(c, "mute");
  }
  const body = await readOptionalParams(c, ApiMuteAccountParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  // Both default when left out (or `null`): notifications muted too, no expiry.
  const notifications = body.value.notifications ?? true;
  const duration = body.value.duration ?? 0;
  const expiresAt =
    Number.isFinite(duration) && duration > 0
      ? new Date(Date.now() + duration * 1000).toISOString()
      : null;
  const muted = await muteAccount(c.env.DB, user.value.id, target.accountId, target.actorUri, {
    notifications,
    expiresAt,
  });
  if (muted.isErr()) {
    return jsonRepositoryError(c, muted.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.accountId ?? targetId);
};

export const postV1AccountsByIdUnmute = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/unmute">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";
  const target = await relationshipTarget(c, identity.value, targetId);
  if (!target) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.accountId === user.value.id) {
    return selfTargetError(c, "unmute");
  }
  const unmuted = await unmuteAccount(c.env.DB, user.value.id, target.actorUri);
  if (unmuted.isErr()) {
    return jsonRepositoryError(c, unmuted.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.accountId ?? targetId);
};

export const getV1Blocks = async (c: Context<{ Bindings: Env }, "/api/v1/blocks">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const rows = await listBlockedAccounts(c.env.DB, user.value.id, limit, queryCursor(c));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const resolved = await availableAccountDocumentsByIds(
    c.env,
    identity.value,
    rows.value.map((row) => row.accountId),
  );
  if (resolved.isErr()) {
    return jsonRepositoryError(c, resolved.error.message);
  }
  const documents = rows.value.flatMap((row) => resolved.value.get(row.accountId) ?? []);
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(documents);
};

export const getV1Mutes = async (c: Context<{ Bindings: Env }, "/api/v1/mutes">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const rows = await listMutedAccounts(c.env.DB, user.value.id, limit, queryCursor(c));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const resolved = await availableAccountDocumentsByIds(
    c.env,
    identity.value,
    rows.value.map((row) => row.accountId),
  );
  if (resolved.isErr()) {
    return jsonRepositoryError(c, resolved.error.message);
  }
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(rows.value.flatMap((row) => resolved.value.get(row.accountId) ?? []));
};

/**
 * Resolve a relationship target (block, mute, endorsement) to a local
 * account id or a remote actor URI.
 */
