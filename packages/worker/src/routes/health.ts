import { Hono } from "hono";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/healthz", (c) =>
  c.json({
    kind: "Ok",
    service: "tstodon",
  }),
);
