import { InstanceIdentity } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { findAccountById, findAccountByIdOrUsername } from "../../account-store";
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
import { mastodonAccountDocument, mastodonRemoteAccount } from "../../account-documents";
import { mastodonRelationship } from "../../relationship-document";
import { findRemoteActorByUri } from "../../remote-actor-store";
import { RemoteAccountId } from "../../remote-account-id";
import { parseInstanceIdentity } from "../../runtime-config";
import {
  endorseAccount,
  listEndorsements,
  relationshipFlags,
  setAccountNote,
  unendorseAccount,
} from "../../social-store";

export const accountEndorsementRoutes = new Hono<{ Bindings: Env }>();

export const relationshipTarget = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  targetId: string,
): Promise<Readonly<{ accountId: string | null; actorUri: string }> | undefined> => {
  const local = await findAccountByIdOrUsername(c.env.DB, targetId);
  if (local.isOk() && local.value) {
    return {
      accountId: local.value.id,
      actorUri: InstanceIdentity.actorUrl(identity, local.value.username),
    };
  }
  const actorUri = RemoteAccountId.decode(targetId);
  if (actorUri.isOk()) {
    return { accountId: null, actorUri: actorUri.value };
  }
  return undefined;
};

const setEndorsed = async (c: Context<{ Bindings: Env }>, endorse: boolean): Promise<Response> => {
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
  const changed = endorse
    ? await endorseAccount(c.env.DB, user.value.id, target)
    : await unendorseAccount(c.env.DB, user.value.id, targetId);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, targetId);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
};

accountEndorsementRoutes.post("/api/v1/accounts/:id/endorse", (c) => setEndorsed(c, true));
accountEndorsementRoutes.post("/api/v1/accounts/:id/unendorse", (c) => setEndorsed(c, false));

const AccountNoteBodySchema = z.object({ comment: z.string() });

accountEndorsementRoutes.post("/api/v1/accounts/:id/note", async (c) => {
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
  const body = await readBody(c, AccountNoteBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const saved = await setAccountNote(
    c.env.DB,
    user.value.id,
    { ...target, id: targetId },
    body.value.comment,
  );
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, targetId);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
});

const endorsementDocuments = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  ownerId: string,
): Promise<Response> => {
  const limit = queryAccountsLimit(c.req.query("limit"));
  const rows = await listEndorsements(c.env.DB, ownerId, limit, queryCursor(c));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const row of rows.value) {
    if (row.accountId) {
      const account = await findAccountById(c.env.DB, row.accountId);
      if (account.isOk() && account.value) {
        documents.push(await mastodonAccountDocument(c.env, identity, account.value));
        continue;
      }
    }
    const actor = await findRemoteActorByUri(c.env.DB, row.actorUri);
    if (actor.isOk() && actor.value) {
      documents.push(mastodonRemoteAccount(identity, actor.value));
    }
  }
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(documents);
};

accountEndorsementRoutes.get("/api/v1/endorsements", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  return endorsementDocuments(c, identity.value, user.value.id);
});

accountEndorsementRoutes.get("/api/v1/accounts/:id/endorsements", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return endorsementDocuments(c, identity.value, account.value.id);
});
