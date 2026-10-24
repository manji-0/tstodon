import type { Context } from "hono";

/**
 * Requests no route matched: GET and HEAD fall back to static assets, every
 * other method (and any WebSocket upgrade) gets the JSON not-found body.
 */
export const notFound = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  if ((c.req.method === "GET" || c.req.method === "HEAD") && !c.req.header("Upgrade")) {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    // A fetched response's headers are immutable, and middleware that runs
    // after this handler (Void's auth middleware) may still add to them.
    return new Response(asset.body, asset);
  }
  return c.json({ kind: "NotFound" }, 404);
};
