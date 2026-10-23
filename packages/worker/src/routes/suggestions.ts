import type { Context } from "hono";
import { findAccountById, listDirectoryAccounts } from "../account-store";
import { jsonAuthError, jsonRepositoryError, queryAccountsLimit, requireUser } from "../http";
import { mastodonAccountDocuments } from "../account-documents";
import { parseInstanceIdentity } from "../runtime-config";
import { dismissSuggestion, listSuggestionExclusionIds } from "../suggestion-store";

const suggestedAccounts = async (
  c: Context<{ Bindings: Env }>,
): Promise<Response | Record<string, unknown>[]> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const excluded = await listSuggestionExclusionIds(c.env.DB, user.value.id);
  if (excluded.isErr()) {
    return jsonRepositoryError(c, excluded.error.message);
  }
  // Pull a wider directory page, then drop self and already-related accounts.
  const candidates = await listDirectoryAccounts(c.env.DB, {
    order: "active",
    limit: 80,
    offset: 0,
  });
  if (candidates.isErr()) {
    return jsonRepositoryError(c, candidates.error.message);
  }
  const accounts = candidates.value
    .filter((account) => account.id !== user.value.id && !excluded.value.has(account.id))
    .slice(0, limit);
  const documents = await mastodonAccountDocuments(c.env, identity.value, accounts);
  return accounts.flatMap((account) => {
    const document = documents.get(account.id);
    return document ? [document] : [];
  });
};

export const getV1Suggestions = async (c: Context<{ Bindings: Env }, "/api/v1/suggestions">) => {
  const result = await suggestedAccounts(c);
  return Array.isArray(result) ? c.json(result) : result;
};

export const getV2Suggestions = async (c: Context<{ Bindings: Env }, "/api/v2/suggestions">) => {
  const result = await suggestedAccounts(c);
  if (!Array.isArray(result)) {
    return result;
  }
  return c.json(result.map((account) => ({ source: "global", account })));
};

export const deleteV1SuggestionsByAccountId = async (
  c: Context<{ Bindings: Env }, "/api/v1/suggestions/:account_id">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountById(c.env.DB, c.req.param("account_id"));
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const dismissed = await dismissSuggestion(c.env.DB, user.value.id, target.value.id);
  if (dismissed.isErr()) {
    return jsonRepositoryError(c, dismissed.error.message);
  }
  return c.json({});
};
