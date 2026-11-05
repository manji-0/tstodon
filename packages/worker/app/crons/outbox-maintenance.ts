import { env } from "cloudflare:workers";
import { defineScheduled } from "void";
import { type HOURLY_CRON, handleScheduled } from "#src/scheduled-handler";

// Void reads the schedules from this literal; the type keeps the hourly one in
// step with the `HOURLY_CRON` that `handleScheduled` compares against.
export const cron = ["17 * * * *", "17 */6 * * *"] as const satisfies readonly [
  typeof HOURLY_CRON,
  string,
];

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
export default defineScheduled((controller, _bindings, ctx) =>
  handleScheduled(controller, env, ctx),
);
