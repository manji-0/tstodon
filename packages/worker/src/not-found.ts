import type { Context } from "hono";
import { packCacheControl } from "./web-app";

/**
 * Requests no route matched: GET and HEAD fall back to static assets, every
 * other method (and any WebSocket upgrade) gets the JSON not-found body.
 */
export const notFound = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  if ((c.req.method === "GET" || c.req.method === "HEAD") && !c.req.header("Upgrade")) {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    // A fetched response's headers are immutable, and middleware that runs
    // after this handler (Void's auth middleware) may still add to them.
    const response = new Response(asset.body, asset);
    // A 304 carries the cache headers the browser stores for its copy.
    const cacheControl = asset.status < 400 ? packCacheControl(c.req.path) : undefined;
    if (cacheControl) {
      response.headers.set("Cache-Control", cacheControl);
    }
    return response;
  }
  return c.json({ kind: "NotFound" }, 404);
};
