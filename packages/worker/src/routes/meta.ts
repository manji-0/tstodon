import { Hono } from "hono";
import { countAccounts, findAccountById, listDirectoryAccounts } from "../account-store";
import { listConversationsForAccount, latestStatusIdInConversation } from "../conversation-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  readBody,
  requireUser,
} from "../http";
import { mastodonAccountDocument, mastodonStatus, mastodonStatuses } from "../mastodon";
import {
  getMarkers,
  markConversationRead,
  markerBodySchema,
  parseMarkerTimelines,
  upsertMarkers,
  type MarkerTimeline,
} from "../marker-store";
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
metaRoutes.get("/api/v1/trends/links", (c) => c.json([]));
metaRoutes.get("/api/v1/instance/rules", (c) => c.json([]));

metaRoutes.get("/api/v1/markers", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const url = new URL(c.req.url);
  const timelines = parseMarkerTimelines([
    ...url.searchParams.getAll("timeline[]"),
    ...url.searchParams.getAll("timeline"),
  ]);
  if (timelines.length === 0) {
    return c.json({});
  }
  const markers = await getMarkers(c.env.DB, user.value.id, timelines);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  return c.json(markers.value);
});

metaRoutes.post("/api/v1/markers", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, markerBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const patches: Array<{ timeline: MarkerTimeline; last_read_id: string }> = [];
  if (body.value.home?.last_read_id) {
    patches.push({ timeline: "home", last_read_id: body.value.home.last_read_id });
  }
  if (body.value.notifications?.last_read_id) {
    patches.push({
      timeline: "notifications",
      last_read_id: body.value.notifications.last_read_id,
    });
  }
  const markers = await upsertMarkers(c.env.DB, user.value.id, patches);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  return c.json(markers.value);
});

metaRoutes.get("/api/v1/conversations", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const conversations = await listConversationsForAccount(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit"), 20),
  );
  if (conversations.isErr()) {
    return jsonRepositoryError(c, conversations.error.message);
  }
  const documents = [];
  for (const conversation of conversations.value) {
    const accounts = [];
    for (const accountId of conversation.accountIds) {
      const account = await findAccountById(c.env.DB, accountId);
      if (account.isOk() && account.value) {
        accounts.push(await mastodonAccountDocument(c.env, identity.value, account.value));
      }
    }
    const lastStatus = await mastodonStatus(
      c.env,
      identity.value,
      conversation.lastStatus,
      user.value.id,
    );
    documents.push({
      id: conversation.id,
      unread: conversation.unread,
      accounts,
      last_status: lastStatus ?? null,
    });
  }
  return c.json(documents);
});

metaRoutes.post("/api/v1/conversations/:id/read", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const conversationId = c.req.param("id");
  const latest = await latestStatusIdInConversation(c.env.DB, user.value.id, conversationId);
  if (latest.isErr()) {
    return jsonRepositoryError(c, latest.error.message);
  }
  if (!latest.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const marked = await markConversationRead(c.env.DB, user.value.id, conversationId, latest.value);
  if (marked.isErr()) {
    return jsonRepositoryError(c, marked.error.message);
  }
  return c.body(null, 200);
});

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
