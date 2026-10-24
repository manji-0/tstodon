// Playwright's web server for the browser e2e suite: a fresh local database,
// migrated, then the Worker in Void's dev server on http://localhost:8793
// with e2e/web.wrangler.jsonc (mail captured in APP_CACHE).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = "e2e/web.wrangler.jsonc";
const state = ".wrangler/e2e-web";

if (!existsSync(path.join(root, "packages/worker/assets/packs/tstodon-web.json"))) {
  console.error("The Mastodon web UI is not built. Run `pnpm web:build` first.");
  process.exit(1);
}

rmSync(path.join(root, state), { recursive: true, force: true });
execFileSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "tstodon-e2e-web",
    "--local",
    "--config",
    config,
    "--persist-to",
    state,
  ],
  { cwd: root, stdio: "inherit" },
);

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
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("exit", (code) => process.exit(code ?? 0));
