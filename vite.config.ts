import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// The two-instance e2e harness (`process-compose.yaml`) runs one `vp dev` per
// instance, each with its own Worker config, local state, and Vite cache.
const workerConfig = process.env["TSTODON_WORKER_CONFIG"];
const persistTo = process.env["TSTODON_PERSIST_TO"];

export default defineConfig({
  // Workers static assets come from Vite's public directory (the client build).
  publicDir: "assets",
  ...(persistTo ? { cacheDir: path.join(persistTo, "vite") } : {}),
  plugins: [
    cloudflare({
      ...(workerConfig ? { configPath: workerConfig } : {}),
      ...(persistTo ? { persistState: { path: persistTo }, inspectorPort: false } : {}),
    }),
  ],
  test: {
    // The root `cloudflare()` dev plugin must not reach the test projects:
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
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              compatibilityDate: "2026-08-22",
              bindings: {
                TEST_MIGRATIONS: migrations,
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
