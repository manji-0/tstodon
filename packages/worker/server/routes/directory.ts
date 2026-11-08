import type { Context } from "hono";
import { listDirectoryAccounts } from "../account-store";
import { jsonRepositoryError, queryAccountsLimit } from "../http";
import { mastodonAccountDocument } from "../account-documents";
import { parseInstanceIdentity } from "../runtime-config";

export const getV1Directory = async (c: Context<{ Bindings: Env }, "/api/v1/directory">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const orderRaw = (c.req.query("order") ?? "active").toLowerCase();
  const order = orderRaw === "new" ? "new" : "active";
  const limit = queryAccountsLimit(c.req.query("limit"));
  const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
  const accounts = await listDirectoryAccounts(c.env.DB, { order, limit, offset });
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  const documents = [];
  for (const account of accounts.value) {
    documents.push(await mastodonAccountDocument(c.env, identity.value, account));
  }
  return c.json(documents);
};
