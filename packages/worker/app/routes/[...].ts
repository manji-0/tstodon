import { defineHandler } from "void";
import { app } from "../../src/app";

// Every path Void has no file route for falls through to the Hono app.
// Endpoints move out of here into their own route files one group at a time.
// Hono answers HEAD from the GET route (Void's router has no `app.head`).
const forward = defineHandler((c) => app.fetch(c.req.raw, c.env, c.executionCtx));

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;
