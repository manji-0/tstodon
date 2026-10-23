// The Worker's Void app. Lint, format, and test settings live in the root
// `vite.config.ts`; this config only builds and serves the Worker.
import path from "node:path";
import { voidPlugin } from "void";
import { defineConfig } from "vite-plus";
import { exportEntryClasses, queueConsumerConcurrency } from "./void-plugins";

// The two-instance e2e harness (`process-compose.yaml`) runs one `vp dev` per
// instance, each with its own Worker config (`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`,
// read by the Cloudflare plugin Void wraps), local state, and Vite cache.
// `TSTODON_PERSIST_TO` is relative to the repository root.
const persistTo = process.env["TSTODON_PERSIST_TO"];
const statePath = persistTo
  ? path.resolve(import.meta.dirname, "../..", persistTo)
  : path.join(import.meta.dirname, ".wrangler/state");

export default defineConfig({
  // Workers static assets come from Vite's public directory (the client build).
  publicDir: "assets",
  ...(persistTo ? { cacheDir: path.join(statePath, "vite") } : {}),
  plugins: [
    // Local state stays where `wrangler ... --local -c packages/worker/wrangler.jsonc`
    // reads and writes it. `void:migrations` applies app/db/migrations on `vp dev`
    // to a fixed `.void/` database with its own `_void_migrations` table, not to
    // the `DB` binding's file; local D1 is migrated with `pnpm db:migrate:local`.
    ...voidPlugin({ persistTo: statePath }).filter((plugin) => plugin.name !== "void:migrations"),
    exportEntryClasses(),
    queueConsumerConcurrency(),
  ],
});
