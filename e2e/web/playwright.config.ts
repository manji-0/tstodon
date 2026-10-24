import { defineConfig, devices } from "@playwright/test";

/**
 * Browser e2e: Mastodon's web UI against the Worker in Void's dev server.
 * Needs `pnpm web:build`; run with `pnpm e2e:web`.
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
      url: "http://localhost:8793/healthz",
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // The stand-in remote server the remote-account scenario looks up.
      command: "node e2e/web/remote-server.mjs",
      cwd: "../..",
      url: "http://127.0.0.1:8794/health",
      reuseExistingServer: false,
    },
  ],
});
