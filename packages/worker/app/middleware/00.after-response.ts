// Work a handler hands to `afterResponse` (server/after-response.ts) starts
// once the handler has returned, off the response's critical path. Named to
// sort first, so it wraps every other middleware.
import type { Context, Next } from "hono";
import { withAfterResponse } from "#server/after-response";

export default (_c: Context<{ Bindings: Env }>, next: Next) => withAfterResponse(() => next());
