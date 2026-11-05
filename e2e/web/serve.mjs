// Playwright's web server for the browser e2e suite: a fresh copy of the
// migrated database (database.mjs), then the Worker in Void's dev server on
// http://localhost:8793 with e2e/web.wrangler.jsonc (mail captured in APP_CACHE).
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { config, migratedDatabase, root } from "./database.mjs";

const state = ".wrangler/e2e-web";

if (!existsSync(path.join(root, "packages/worker/assets/packs/tstodon-web.json"))) {
  console.error("The Mastodon web UI is not built. Run `pnpm web:build` first.");
  process.exit(1);
}

// Only `v3`, the Worker's local storage, is replaced. `vite` beside it is
// Vite's dependency cache, which takes about a minute to rebuild.
rmSync(path.join(root, state, "v3"), { recursive: true, force: true });
cpSync(path.join(migratedDatabase(), "v3"), path.join(root, state, "v3"), { recursive: true });

const server = spawn(
  "pnpm",
  [
    "exec",
    "vp",
    "-C",
    "packages/worker",
    "dev",
    "--port",
    "8793",
    "--strictPort",
    "--host",
    "localhost",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: `../../${config}`,
      TSTODON_PERSIST_TO: state,
      VOID_INSPECTOR_PORT: "false",
      // fixtures.ts reads the captured mail through the local explorer API.
      X_LOCAL_EXPLORER: "true",
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code) => process.exit(code ?? 0));
