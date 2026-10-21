import { Hono } from "hono";
import { accountRoutes } from "./routes/accounts";
import { activityPubRoutes } from "./routes/activitypub";
import { adminRoutes } from "./routes/admin";
import { announcementRoutes } from "./routes/announcements";
import { appRoutes } from "./routes/apps";
import { conversationRoutes } from "./routes/conversations";
import { customEmojiRoutes } from "./routes/custom-emojis";
import { directoryRoutes } from "./routes/directory";
import { discoveryRoutes } from "./routes/discovery";
import { domainBlockRoutes } from "./routes/domain-blocks";
import { filterRoutes } from "./routes/filters";
import { followRequestRoutes } from "./routes/follow-requests";
import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instance";
import { listRoutes } from "./routes/lists";
import { loginRoutes } from "./routes/login";
import { markerRoutes } from "./routes/markers";
import { mediaRoutes } from "./routes/media";
import { notificationRequestRoutes } from "./routes/notification-requests";
import { notificationRoutes } from "./routes/notifications";
import { pollRoutes } from "./routes/polls";
import { pushRoutes } from "./routes/push";
import { reportRoutes } from "./routes/reports";
import { scheduledStatusRoutes } from "./routes/scheduled-statuses";
import { searchRoutes } from "./routes/search";
import { statusRoutes } from "./routes/statuses";
import { suggestionRoutes } from "./routes/suggestions";
import { tagRoutes } from "./routes/tags";
import { timelineRoutes } from "./routes/timelines";
import { trendRoutes } from "./routes/trends";
import { apiCors, mediaCors } from "./cors";
import { jsonAuthError, requireUser } from "./http";

export const app = new Hono<{ Bindings: Env }>();

// Public media proxy (local-core / same-origin MEDIA_PUBLIC_BASE_URL). Production R2
// custom domains need a matching bucket CORS policy (see docs/operations).
app.use("/media/*", mediaCors());
app.use("/attachments/*", mediaCors());
app.use("/avatars/*", mediaCors());
app.use("/headers/*", mediaCors());

// Browser Mastodon clients: allowlisted Origin + Authorization / Access JWT headers.
app.use("/api/*", apiCors());

app.route("/", healthRoutes);
app.route("/", loginRoutes);
app.route("/", instanceRoutes);
app.route("/", announcementRoutes);
app.route("/", conversationRoutes);
app.route("/", customEmojiRoutes);
app.route("/", directoryRoutes);
app.route("/", markerRoutes);
app.route("/", suggestionRoutes);
app.route("/", trendRoutes);
app.route("/", discoveryRoutes);
app.route("/", domainBlockRoutes);
app.route("/", appRoutes);
app.route("/", listRoutes);
app.route("/", accountRoutes);
app.route("/", followRequestRoutes);
app.route("/", statusRoutes);
app.route("/", scheduledStatusRoutes);
app.route("/", timelineRoutes);
app.route("/", mediaRoutes);
app.route("/", notificationRequestRoutes);
app.route("/", notificationRoutes);
app.route("/", tagRoutes);
app.route("/", pollRoutes);
app.route("/", pushRoutes);
app.route("/", filterRoutes);
app.route("/", reportRoutes);
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
