import type { Context, Next } from "hono";
import { getV1Streaming } from "#src/routes/streaming";

// Mastodon clients also connect to `/api/v1/streaming/` and the per-stream
// paths under it (`/api/v1/streaming/user`); all of them are the same socket.
export default (c: Context<{ Bindings: Env }>, next: Next) =>
  c.req.method === "GET" && c.req.path.startsWith("/api/v1/streaming/")
    ? getV1Streaming(c)
    : next();
