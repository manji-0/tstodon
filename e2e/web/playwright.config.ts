import { defineConfig, devices } from "@playwright/test";
import { checkoutId, checkoutPrefix } from "./checkout.mjs";

/**
 * Browser e2e: Mastodon's web UI against the Worker in Void's dev server,
 * which serves the built UI (`packages/worker/dist/client`). Run with
 * `pnpm e2e:web`, which migrates the database (database.mjs) and builds
 * first.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // The scenarios share one server and database; run them one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../.cache/e2e-web/results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:8793",
    // Stable UI strings for the selectors.
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--no-proxy-server"] },
  },
  webServer: [
    {
      command: "node e2e/web/serve.mjs",
      cwd: "../..",
      // This checkout's servers only (checkout.mjs): with another checkout's
      // e2e on these ports, this run fails to start rather than use them.
      url: `http://localhost:8793${checkoutPrefix}/healthz`,
      // The budget was 180 s while serve.mjs also applied the migrations; they
      // now run before Playwright starts (database.mjs). On a 4-CPU machine the
      // server answered in 17 to 33 s with a warm Vite cache (load average 6 to
      // 11) and 45 to 86 s with a cold one (fresh clone or dependency change,
      // load average 8 to 16). 150 s leaves room for the slowest of those, not
      // for the migrations as well.
      timeout: 150_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // The stand-in remote server the remote-account scenario looks up.
      command: "node e2e/web/remote-server.mjs",
      cwd: "../..",
      url: `http://127.0.0.1:8794/health?checkout=${checkoutId}`,
      reuseExistingServer: false,
    },
  ],
});
