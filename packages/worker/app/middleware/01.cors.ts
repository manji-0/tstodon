import type { Context, Next } from "hono";
import { apiCors, isApiCorsPath, mediaCors } from "#server/cors";

// Public media proxy (local-core / same-origin MEDIA_PUBLIC_BASE_URL). Production R2
// custom domains need a matching bucket CORS policy (see docs/operations).
const MEDIA_PREFIXES = ["/media", "/attachments", "/avatars", "/headers"];
const media = mediaCors();

// Browser Mastodon clients: allowlisted Origin + Authorization header, for the
// API, for redeeming and revoking OAuth tokens, and for the discovery documents.
const api = apiCors();

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

export default (c: Context<{ Bindings: Env }, string>, next: Next) => {
  const path = c.req.path;
  if (MEDIA_PREFIXES.some((prefix) => under(path, prefix))) {
    return media(c, next);
  }
  if (isApiCorsPath(path)) {
    return api(c, next);
  }
  return next();
};
