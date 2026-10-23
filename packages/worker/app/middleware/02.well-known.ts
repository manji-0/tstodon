import type { Context, Next } from "hono";
import { getWellKnownNodeinfo, getWellKnownWebfinger } from "#src/routes/discovery";

// Void's route scanner skips dot directories, so `routes/.well-known/` would
// never be registered. Serve the two discovery documents here instead.
const WELL_KNOWN = {
  "/.well-known/webfinger": getWellKnownWebfinger,
  "/.well-known/nodeinfo": getWellKnownNodeinfo,
} as const;

const isWellKnownPath = (path: string): path is keyof typeof WELL_KNOWN =>
  Object.hasOwn(WELL_KNOWN, path);

export default (c: Context<{ Bindings: Env }>, next: Next) => {
  const path = c.req.path;
  if ((c.req.method === "GET" || c.req.method === "HEAD") && isWellKnownPath(path)) {
    return WELL_KNOWN[path](c);
  }
  return next();
};
