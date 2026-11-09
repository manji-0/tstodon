// Playwright's web server for the browser e2e suite: a fresh copy of the
// migrated database (database.mjs), then the Worker in Void's dev server on
// http://localhost:8795 with e2e/web.wrangler.jsonc (mail captured in APP_CACHE),
// behind the stand-in Access edge (access-edge.mjs) on http://localhost:8793,
// the origin the browser opens.
// The dev server serves the built web UI (packages/worker/dist/client, which
// `pnpm e2e:web` builds first) as deployed, not the frontend's sources: React's
// development build logs warnings the scenarios count as console errors.
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { startAccessEdge } from "./access-edge.mjs";
import { config, migratedDatabase, root } from "./database.mjs";

const host = "localhost";
/** The public origin's port (INSTANCE_DOMAIN in e2e/web.wrangler.jsonc). */
const edgePort = 8793;
/** Void's dev server, reached only through the edge. */
const workerPort = 8795;

const state = ".wrangler/e2e-web";

if (!existsSync(path.join(root, "packages/worker/dist/client/.vite/manifest.json"))) {
  console.error("The web UI is not built. Run `pnpm build` first (`pnpm e2e:web` does).");
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
    String(workerPort),
    "--strictPort",
    "--host",
    host,
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: `../../${config}`,
      TSTODON_PERSIST_TO: state,
      TSTODON_WEB_CLIENT: "build",
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

await startAccessEdge({ host, listenPort: edgePort, originPort: workerPort });
