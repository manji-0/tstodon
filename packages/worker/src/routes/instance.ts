import { Hono } from "hono";
import { countAccounts } from "../account-store";
import { jsonRepositoryError } from "../http";
import { parseInstanceIdentity } from "../runtime-config";
import { countStatuses } from "../status-store";

export const instanceRoutes = new Hono<{ Bindings: Env }>();

instanceRoutes.get("/api/v1/instance", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const users = await countAccounts(c.env.DB);
  const statuses = await countStatuses(c.env.DB);
  if (users.isErr()) {
    return jsonRepositoryError(c, users.error.message);
  }
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const instance = identity.value;
  return c.json({
    kind: "MastodonInstance",
    uri: instance.domain,
    title: instance.name,
    short_description: instance.description,
    description: instance.description,
    email: instance.contactEmail,
    version: "0.1.0 (compatible; tstodon)",
    languages: instance.languages,
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    configuration: {
      urls: {
        streaming: `wss://${instance.domain}`,
      },
    },
    thumbnail: instance.thumbnailUrl,
    source_url: instance.sourceUrl,
    stats: {
      user_count: users.value,
      status_count: statuses.value,
      domain_count: 1,
    },
  });
});
