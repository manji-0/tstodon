import type { Context } from "hono";
import { ApiGetDirectoryParamsSchema } from "@tstodon/api";
import { listDirectoryAccounts } from "../account-store";
import { jsonRepositoryError, jsonValidationError, queryAccountsLimit } from "../http";
import { documentsInOrder, mastodonAccountDocuments } from "../account-documents";
import { readQueryParams } from "../request-params";
import { parseInstanceIdentity } from "../runtime-config";

export const getV1Directory = async (c: Context<{ Bindings: Env }, "/api/v1/directory">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const params = readQueryParams(c, ApiGetDirectoryParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const order = (params.value.order ?? "active").toLowerCase() === "new" ? "new" : "active";
  const limit = queryAccountsLimit(params.value.limit);
  const offset = Math.max(0, params.value.offset ?? 0);
  // Only local accounts are listed, so `local` changes nothing.
  const accounts = await listDirectoryAccounts(c.env.DB, { order, limit, offset });
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  const documents = await mastodonAccountDocuments(c.env, identity.value, accounts.value);
  return c.json(
    documentsInOrder(
      accounts.value.map((account) => account.id),
      documents,
    ),
  );
};
