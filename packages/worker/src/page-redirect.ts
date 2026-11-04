import type { Context } from "hono";

/**
 * Redirect a server-rendered page to `path` on this site, exactly as given.
 * Void wraps `c.redirect` so a path-only target also carries the request's
 * own query string; building the response here keeps only the query the
 * target names (a `return_to`, a `?notice=`).
 */
export const pageRedirect = (
  _c: Context<{ Bindings: Env }>,
  path: string,
  status: 301 | 302 | 303 = 302,
): Response => new Response(null, { status, headers: { Location: path } });

/** The sign-in page, returning to `back` (this request's path and query by default) afterwards. */
export const signInRedirect = (
  c: Context<{ Bindings: Env }>,
  back: URL = new URL(c.req.url),
): Response =>
  pageRedirect(c, `/auth/sign_in?return_to=${encodeURIComponent(back.pathname + back.search)}`);
