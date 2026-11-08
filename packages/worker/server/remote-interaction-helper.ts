import type { Context } from "hono";
import { entryTags, webManifest } from "./web-app";

/**
 * Mastodon's `/remote_interaction_helper`: the page the signed-out
 * interaction modal ("interact from your server") loads in an iframe. Its one
 * script (the `remote_interaction_helper` pack, built from Mastodon's source
 * by `pnpm web:build`) does the WebFinger lookups of the visitor's server from
 * here, where the strict `connect-src` of the main app does not apply, and
 * talks to the parent window by `postMessage` after checking its origin.
 */

/**
 * The page's policy, as Mastodon's `RemoteInteractionHelperController` sets
 * it: nothing but this origin's scripts, requests over HTTPS (the lookups),
 * and framing by this origin only.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src https:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export const getRemoteInteractionHelper = async (c: Context<{ Bindings: Env }>) => {
  const manifest = await webManifest(c.env, c.req.url);
  if (!manifest?.remoteInteractionHelper) {
    return c.text("Not found", 404);
  }
  return c.html(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="robots" content="noindex">
    ${entryTags(manifest.remoteInteractionHelper)}
  </head>
</html>`,
    200,
    {
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=30, stale-if-error=86400",
    },
  );
};
