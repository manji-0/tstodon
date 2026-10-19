import { Hono } from "hono";
import { accountRoutes } from "./routes/accounts";
import { activityPubRoutes } from "./routes/activitypub";
import { adminRoutes } from "./routes/admin";
import { appRoutes } from "./routes/apps";
import { discoveryRoutes } from "./routes/discovery";
import { domainBlockRoutes } from "./routes/domain-blocks";
import { followRequestRoutes } from "./routes/follow-requests";
import { healthRoutes } from "./routes/health";
import { loginRoutes } from "./routes/login";
import { instanceRoutes } from "./routes/instance";
import { mediaRoutes } from "./routes/media";
import { listRoutes } from "./routes/lists";
import { metaRoutes } from "./routes/meta";
import { moderationRoutes } from "./routes/moderation";
import { notificationRequestRoutes } from "./routes/notification-requests";
import { notificationRoutes } from "./routes/notifications";
import { pollRoutes } from "./routes/polls";
import { searchRoutes } from "./routes/search";
import { statusRoutes } from "./routes/statuses";
import { tagRoutes } from "./routes/tags";
import { timelineRoutes } from "./routes/timelines";
import { jsonAuthError, requireUser } from "./http";

export const app = new Hono<{ Bindings: Env }>();

app.route("/", healthRoutes);
app.route("/", loginRoutes);
app.route("/", instanceRoutes);
app.route("/", metaRoutes);
app.route("/", discoveryRoutes);
app.route("/", domainBlockRoutes);
app.route("/", appRoutes);
app.route("/", listRoutes);
app.route("/", accountRoutes);
app.route("/", followRequestRoutes);
app.route("/", statusRoutes);
app.route("/", timelineRoutes);
app.route("/", mediaRoutes);
app.route("/", notificationRequestRoutes);
app.route("/", notificationRoutes);
app.route("/", tagRoutes);
app.route("/", pollRoutes);
app.route("/", moderationRoutes);
app.route("/", searchRoutes);
app.route("/", adminRoutes);
app.route("/", activityPubRoutes);

app.get("/api/v1/streaming", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const stub = c.env.STREAM_HUB.get(c.env.STREAM_HUB.idFromName(user.value.id));
  return stub.fetch(c.req.raw);
});

app.notFound(async (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ kind: "NotFound" }, 404);
});
