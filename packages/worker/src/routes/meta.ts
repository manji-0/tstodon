import { Hono } from "hono";
import { countAccounts, listDirectoryAccounts } from "../account-store";
import { jsonRepositoryError, queryLimit } from "../http";
import { mastodonAccountDocument, mastodonStatuses } from "../mastodon";
import { listPeerDomains } from "../remote-actor-store";
import { parseInstanceIdentity } from "../runtime-config";
import {
  countStatuses,
  listTrendingStatuses,
  listTrendingTags,
  listWeeklyStatusActivity,
} from "../status-store";

export const metaRoutes = new Hono<{ Bindings: Env }>();

metaRoutes.get("/api/v1/custom_emojis", (c) => c.json([]));
metaRoutes.get("/api/v1/announcements", (c) => c.json([]));
metaRoutes.get("/api/v1/lists", (c) => c.json([]));
metaRoutes.get("/api/v1/suggestions", (c) => c.json([]));
metaRoutes.get("/api/v1/conversations", (c) => c.json([]));
metaRoutes.get("/api/v1/markers", (c) => c.json({}));
metaRoutes.get("/api/v1/trends/links", (c) => c.json([]));
metaRoutes.get("/api/v1/instance/rules", (c) => c.json([]));

metaRoutes.get("/api/v1/trends", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const tags = await listTrendingTags(c.env.DB, queryLimit(c.req.query("limit"), 10));
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  return c.json(
    tags.value.map((tag) => ({
      name: tag.name,
      url: `https://${identity.value.domain}/tags/${tag.name}`,
      history: [{ day: `${Math.floor(Date.now() / 1000)}`, accounts: "0", uses: String(tag.uses) }],
    })),
  );
});

metaRoutes.get("/api/v1/trends/tags", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const tags = await listTrendingTags(c.env.DB, queryLimit(c.req.query("limit"), 10));
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  return c.json(
    tags.value.map((tag) => ({
      name: tag.name,
      url: `https://${identity.value.domain}/tags/${tag.name}`,
      history: [{ day: `${Math.floor(Date.now() / 1000)}`, accounts: "0", uses: String(tag.uses) }],
    })),
  );
});

metaRoutes.get("/api/v1/trends/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const statuses = await listTrendingStatuses(c.env.DB, queryLimit(c.req.query("limit"), 20));
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, undefined));
});

metaRoutes.get("/api/v1/instance/peers", async (c) => {
  const peers = await listPeerDomains(c.env.DB);
  if (peers.isErr()) {
    return jsonRepositoryError(c, peers.error.message);
  }
  return c.json(peers.value);
});

metaRoutes.get("/api/v1/instance/activity", async (c) => {
  const activity = await listWeeklyStatusActivity(c.env.DB, 12);
  if (activity.isErr()) {
    return jsonRepositoryError(c, activity.error.message);
  }
  return c.json(
    activity.value.map((row) => ({
      week: row.week,
      statuses: String(row.statuses),
      logins: "0",
      registrations: String(row.registrations),
    })),
  );
});

metaRoutes.get("/api/v1/directory", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const orderRaw = (c.req.query("order") ?? "active").toLowerCase();
  const order = orderRaw === "new" ? "new" : "active";
  const limit = queryLimit(c.req.query("limit"), 40);
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
});

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
      polls: {
        max_options: 4,
        max_characters_per_option: 50,
        min_expiration: 300,
        max_expiration: 2629746,
      },
    },
    registrations: { enabled: false, approval_required: true, message: null },
    contact: { email: instance.contactEmail, account: null },
    rules: [],
  });
});
