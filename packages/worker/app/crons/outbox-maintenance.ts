import { env } from "cloudflare:workers";
import { defineScheduled } from "void";
import { handleScheduled } from "../../src/scheduled-handler";

export const cron = ["17 * * * *", "17 */6 * * *"];

// Void types its `env` argument loosely; the module `env` carries the generated `Env`.
export default defineScheduled((controller, _bindings, ctx) =>
  handleScheduled(controller, env, ctx),
);
