import type { Context } from "hono";
import { serveNodeinfo } from "#server/nodeinfo";

export const GET = (c: Context<{ Bindings: Env }, "/nodeinfo/2.0">) => serveNodeinfo(c, "2.0");
