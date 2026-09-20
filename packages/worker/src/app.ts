import { Hono } from "hono";
import { discoveryRoutes } from "./routes/discovery";
import { healthRoutes } from "./routes/health";
import { instanceRoutes } from "./routes/instance";

export const app = new Hono<{ Bindings: Env }>();

app.route("/", healthRoutes);
app.route("/", instanceRoutes);
app.route("/", discoveryRoutes);

app.notFound(async (c) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ kind: "NotFound" }, 404);
});
