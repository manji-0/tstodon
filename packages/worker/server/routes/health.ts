import type { Context } from "hono";

export const getHealthz = (c: Context<{ Bindings: Env }, "/healthz">) =>
  c.json({
    kind: "Ok",
    service: "tstodon",
  });
