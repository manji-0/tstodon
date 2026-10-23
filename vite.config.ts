import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { voidPlugin } from "void";
import { defineConfig } from "vite-plus";
import { exportEntryClasses, queueConsumerConcurrency } from "./void-plugins";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// The two-instance e2e harness (`process-compose.yaml`) runs one `vp dev` per
// instance, each with its own Worker config (`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`,
// read by the Cloudflare plugin Void wraps), local state, and Vite cache.
const persistTo = process.env["TSTODON_PERSIST_TO"];

export default defineConfig({
  // Workers static assets come from Vite's public directory (the client build).
  publicDir: "assets",
  ...(persistTo ? { cacheDir: path.join(persistTo, "vite") } : {}),
  plugins: [
    // Keep local state where `wrangler ... --local` reads and writes it.
    voidPlugin({ persistTo: persistTo ?? ".wrangler/state" }),
    exportEntryClasses(),
    queueConsumerConcurrency(),
  ],
  test: {
    // The root `voidPlugin()` dev plugins must not reach the test projects:
    // each project gets its own Vite server and ignores the root config.
    sharedViteServer: false,
    projects: [
      {
        extends: false,
        test: {
          name: "domain",
          include: ["packages/core/src/**/*.test.ts", "packages/domain/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: false,
        plugins: [
          cloudflareTest({
            // The build output: tests run the Worker Void generates, so run
            // `vp build .` first (`pnpm test` does).
            wrangler: { configPath: "./dist/ssr/wrangler.json" },
            miniflare: {
              compatibilityDate: "2026-08-22",
              bindings: {
                TEST_MIGRATIONS: migrations,
                // Test-only VAPID key pair (never used outside the test runner).
                VAPID_PRIVATE_JWK: JSON.stringify({
                  kty: "EC",
                  crv: "P-256",
                  x: "gNxME-8f4ciT4HFggx6WMgqEWqHYiTfqpbrQE-RpwEc",
                  y: "QHnjJ6Kcnf9YbOBBZ6Wnzr154fTk8gmy7_0ZkjmJXHg",
                  d: "447-B_gSeFow1mKFlPPSrLUKUsliq3AtIkbXvcoTBKY",
                }),
                VAPID_SUBJECT: "mailto:admin@example.com",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          // Integration tests run in workerd; under a full parallel run the
          // longer request chains need more than Vitest's 5s default.
          testTimeout: 15_000,
          include: ["packages/worker/src/**/*.test.ts"],
          setupFiles: ["./packages/worker/test/apply-migrations.ts"],
        },
      },
    ],
  },
  fmt: {
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    arrowParens: "always",
    endOfLine: "lf",
    ignorePatterns: [
      ".claude/**",
      "dist/**",
      "packages/*/dist/**",
      ".wrangler/**",
      ".void/**",
      "pnpm-lock.yaml",
      "worker-configuration.d.ts",
    ],
  },
  lint: {
    plugins: ["typescript"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: [
      "dist/**",
      "packages/*/dist/**",
      ".wrangler/**",
      ".void/**",
      "e2e/instances/.wrangler/**",
      "worker-configuration.d.ts",
    ],
    rules: {
      "typescript/consistent-type-definitions": ["error", "type"],
      "typescript/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
        },
      ],
      "typescript/no-misused-spread": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
