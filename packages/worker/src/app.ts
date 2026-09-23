import { Hono } from "hono";
import { accountRoutes } from "./routes/accounts";
import { activityPubRoutes } from "./routes/activitypub";
import { appRoutes } from "./routes/apps";
import { discoveryRoutes } from "./routes/discovery";
import { healthRoutes } from "./routes/health";
import { loginRoutes } from "./routes/login";
import { instanceRoutes } from "./routes/instance";
import { mediaRoutes } from "./routes/media";
import { listRoutes } from "./routes/lists";
import { metaRoutes } from "./routes/meta";
import { moderationRoutes } from "./routes/moderation";
import { notificationRoutes } from "./routes/notifications";
import { pollRoutes } from "./routes/polls";
import { searchRoutes } from "./routes/search";
import { statusRoutes } from "./routes/statuses";
import { timelineRoutes } from "./routes/timelines";
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
app.route("/", metaRoutes);
app.route("/", discoveryRoutes);
app.route("/", appRoutes);
app.route("/", listRoutes);
app.route("/", accountRoutes);
app.route("/", statusRoutes);
app.route("/", timelineRoutes);
app.route("/", mediaRoutes);
app.route("/", notificationRoutes);
app.route("/", pollRoutes);
app.route("/", moderationRoutes);
app.route("/", searchRoutes);
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
