// The Void app: the Worker (`app/`, `server/`) and its client, Mastodon's web
// frontend (`src/`, composed in `web-build.ts`), built by one `vite build`.
// Lint, format, and Worker test settings live in the root `vite.config.ts`;
// the frontend's tests in `vitest.config.ts` beside this file.
import path from "node:path";
import { voidPlugin } from "void";
import { defineConfig, mergeConfig } from "vite-plus";
import { exportEntryClasses, queueConsumerConcurrency } from "./void-plugins";
import {
  buildClientFirst,
  upstreamAssets,
  webClientConfig,
  webManifest,
  webSharedConfig,
} from "./web-build";

// The two-instance e2e harness (`process-compose.yaml`) runs one `vp dev` per
// instance, each with its own Worker config (`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`,
// read by the Cloudflare plugin Void wraps), local state, and Vite cache.
// `TSTODON_PERSIST_TO` is relative to the repository root.
const persistTo = process.env["TSTODON_PERSIST_TO"];
const statePath = persistTo
  ? path.resolve(import.meta.dirname, "../..", persistTo)
  : path.join(import.meta.dirname, ".wrangler/state");

// `TSTODON_WEB_CLIENT=build` makes `vp dev` serve the built client
// (`dist/client`, from a prior `vp build`) instead of the frontend's sources:
// the browser e2e suite runs the production UI, as deployed, against the dev
// Worker.
const builtClient = process.env["TSTODON_WEB_CLIENT"] === "build";

const voidConfig = defineConfig({
  // Committed static files (and upstream's emoji, linked in by `upstreamAssets`),
  // copied into the client build beside the frontend's output.
  publicDir: builtClient ? "dist/client" : "public",
  ...(persistTo ? { cacheDir: path.join(statePath, "vite") } : {}),
  // The Worker build reads the client's Vite manifest, so the client builds first.
  builder: { buildApp: buildClientFirst },
  plugins: [
    upstreamAssets(),
    webManifest(builtClient ? { source: "build" } : {}),
    // Local state stays where `wrangler ... --local -c packages/worker/wrangler.jsonc`
    // reads and writes it. `void:migrations` applies app/db/migrations on `vp dev`
    // to a fixed `.void/` database with its own `_void_migrations` table, not to
    // the `DB` binding's file; local D1 is migrated with `pnpm db:migrate:local`.
    ...voidPlugin({ persistTo: statePath }).filter((plugin) => plugin.name !== "void:migrations"),
    exportEntryClasses(),
    queueConsumerConcurrency(),
  ],
});

export default defineConfig(async () =>
  mergeConfig(mergeConfig(voidConfig, webSharedConfig()), await webClientConfig()),
);
