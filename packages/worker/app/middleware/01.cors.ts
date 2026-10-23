import type { Context, Next } from "hono";
import { apiCors, mediaCors } from "#src/cors";

// Public media proxy (local-core / same-origin MEDIA_PUBLIC_BASE_URL). Production R2
// custom domains need a matching bucket CORS policy (see docs/operations).
const MEDIA_PREFIXES = ["/media", "/attachments", "/avatars", "/headers"];
const media = mediaCors();

// Browser Mastodon clients: allowlisted Origin + Authorization / Access JWT headers.
const api = apiCors();

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

export default (c: Context<{ Bindings: Env }>, next: Next) => {
  const path = c.req.path;
  if (MEDIA_PREFIXES.some((prefix) => under(path, prefix))) {
    return media(c, next);
  }
  if (under(path, "/api")) {
    return api(c, next);
  }
  return next();
};
