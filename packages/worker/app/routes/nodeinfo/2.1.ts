import type { Context } from "hono";
import { serveNodeinfo } from "#server/nodeinfo";

export const GET = (c: Context<{ Bindings: Env }, "/nodeinfo/2.1">) => serveNodeinfo(c, "2.1");
