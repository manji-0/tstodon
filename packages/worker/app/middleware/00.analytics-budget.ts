// Analytics Engine caps the data points one invocation writes; count this
// request's (see `withMetricsBudget` in server/metrics.ts). Named to sort
// before `00.ip-block` so the budget covers every later middleware.
import type { Context, Next } from "hono";
import { withMetricsBudget } from "#server/metrics";

export default (c: Context<{ Bindings: Env }>, next: Next) =>
  withMetricsBudget(c.env, "fetch", () => next());
