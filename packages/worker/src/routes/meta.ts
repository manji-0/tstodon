import { Hono } from "hono";
import { countAccounts } from "../account-store";
import { jsonRepositoryError } from "../http";
import { parseInstanceIdentity } from "../runtime-config";
import { countStatuses } from "../status-store";

export const metaRoutes = new Hono<{ Bindings: Env }>();

metaRoutes.get("/api/v1/custom_emojis", (c) => c.json([]));
metaRoutes.get("/api/v1/announcements", (c) => c.json([]));
metaRoutes.get("/api/v1/lists", (c) => c.json([]));
metaRoutes.get("/api/v1/suggestions", (c) => c.json([]));
metaRoutes.get("/api/v1/conversations", (c) => c.json([]));
metaRoutes.get("/api/v1/markers", (c) => c.json({}));
metaRoutes.get("/api/v1/trends", (c) => c.json([]));
metaRoutes.get("/api/v1/trends/tags", (c) => c.json([]));
metaRoutes.get("/api/v1/trends/statuses", (c) => c.json([]));
metaRoutes.get("/api/v1/trends/links", (c) => c.json([]));
metaRoutes.get("/api/v1/instance/peers", (c) => c.json([]));
metaRoutes.get("/api/v1/instance/rules", (c) => c.json([]));
metaRoutes.get("/api/v1/instance/activity", (c) => c.json([]));
metaRoutes.get("/api/v1/directory", (c) => c.json([]));

metaRoutes.get("/api/v2/instance", async (c) => {
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
    domain: instance.domain,
    title: instance.name,
    version: "0.1.0 (compatible; tstodon)",
    source_url: instance.sourceUrl,
    description: instance.description,
    usage: {
      users: { active_month: users.value },
    },
    thumbnail: { url: instance.thumbnailUrl },
    languages: instance.languages,
    configuration: {
      urls: { streaming: `wss://${instance.domain}` },
      statuses: { max_characters: 500, max_media_attachments: 4 },
      media_attachments: { supported_mime_types: ["image/jpeg", "image/png", "image/webp"] },
      polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
    },
    registrations: { enabled: false, approval_required: true, message: null },
    contact: { email: instance.contactEmail, account: null },
    rules: [],
  });
});
