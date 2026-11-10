import type { Context } from "hono";
import { ApiUpdateWebSettingsParamsSchema } from "@tstodon/api";
import { warmSchemas } from "@tstodon/core";
import { nowIso } from "../clock";
import { runD1 } from "../d1";
import { upsertWebSettings } from "../generated/prisma/sql";
import { jsonAuthError, jsonRepositoryError, requireUser } from "../http";
import { readParams } from "../request-params";
import { runTyped } from "../typed-sql";

/** The web UI's own preferences are opaque here; this caps what one account may store. */
const MAX_SETTINGS_BYTES = 64 * 1024;

/** Mastodon's `PUT /api/web/settings`: the web UI saves its settings blob. */
export const putApiWebSettings = async (c: Context<{ Bindings: Env }, "/api/web/settings">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readParams(c, ApiUpdateWebSettingsParamsSchema);
  if (body.isErr()) {
    return c.json({ error: "Validation failed", kind: "ValidationError" }, 422);
  }
  const json = JSON.stringify(body.value.data);
  if (json.length > MAX_SETTINGS_BYTES) {
    return c.json({ error: "Settings are too large", kind: "ValidationError" }, 422);
  }
  const stored = await runD1(() =>
    runTyped(c.env.DB, upsertWebSettings(user.value.id, json, nowIso())),
  );
  if (stored.isErr()) {
    return jsonRepositoryError(c, stored.error.message);
  }
  return c.json({});
};

warmSchemas([ApiUpdateWebSettingsParamsSchema]);
