import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  queryCursor,
  readBody,
  requireUser,
  setPaginationLinks,
} from "../../http";
import { mastodonRelationship } from "../../relationship-document";
import { accountDocumentsByIds } from "../../account-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import {
  blockAccount,
  listBlockedAccounts,
  listMutedAccounts,
  muteAccount,
  relationshipFlags,
  unblockAccount,
  unmuteAccount,
} from "../../social-store";
import { relationshipTarget } from "./endorsements";

export const accountBlockMuteRoutes = new Hono<{ Bindings: Env }>();

const MuteBodySchema = z.object({
  notifications: z.union([z.boolean(), z.string(), z.null()]).optional(),
  duration: z.union([z.number(), z.string(), z.null()]).optional(),
});

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
    ? await blockAccount(c.env.DB, user.value.id, target.accountId, target.actorUri)
    : await unblockAccount(c.env.DB, user.value.id, target.actorUri);
  if (written.isErr()) {
    return jsonRepositoryError(c, written.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.accountId ?? targetId);
};

accountBlockMuteRoutes.post("/api/v1/accounts/:id/block", (c) => blockOrUnblock(c, true));
accountBlockMuteRoutes.post("/api/v1/accounts/:id/unblock", (c) => blockOrUnblock(c, false));

accountBlockMuteRoutes.post("/api/v1/accounts/:id/mute", async (c) => {
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
  const body = await readBody(c, MuteBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const notifications =
    body.value.notifications === undefined ||
    body.value.notifications === null ||
    body.value.notifications === true ||
    body.value.notifications === "true";
  const duration = Number(body.value.duration ?? 0);
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
});

accountBlockMuteRoutes.post("/api/v1/accounts/:id/unmute", async (c) => {
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
});

accountBlockMuteRoutes.get("/api/v1/blocks", async (c) => {
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
  const resolved = await accountDocumentsByIds(
    c.env,
    identity.value,
    rows.value.map((row) => row.accountId),
  );
  const documents = rows.value.flatMap((row) => resolved.get(row.accountId) ?? []);
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(documents);
});

accountBlockMuteRoutes.get("/api/v1/mutes", async (c) => {
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
  const resolved = await accountDocumentsByIds(
    c.env,
    identity.value,
    rows.value.map((row) => row.accountId),
  );
  return c.json(rows.value.flatMap((row) => resolved.get(row.accountId) ?? []));
});

/**
 * Resolve a relationship target (block, mute, endorsement) to a local
 * account id or a remote actor URI.
 */
