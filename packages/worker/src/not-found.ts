import type { Context } from "hono";

/**
 * Requests no route matched: GET and HEAD fall back to static assets, every
 * other method gets the JSON not-found body.
 */
export const notFound = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ kind: "NotFound" }, 404);
};
