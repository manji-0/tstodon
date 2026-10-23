import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { voidPlugin } from "void";
import { defineConfig, type Plugin } from "vite-plus";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

// The two-instance e2e harness (`process-compose.yaml`) runs one `vp dev` per
// instance, each with its own Worker config (`CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`,
// read by the Cloudflare plugin Void wraps), local state, and Vite cache.
const persistTo = process.env["TSTODON_PERSIST_TO"];

const entryClassesFile = path.join(import.meta.dirname, "packages/worker/src/entry-classes.ts");

/**
 * Void generates the Worker entry (`.void/entry.ts`) and only exports its own
 * Durable Object classes from it. The Workflow and Durable Object classes that
 * `wrangler.jsonc` binds have to be exported from the same module, so append
 * them to the generated entry. A Worker build that never saw that entry fails,
 * so a Void upgrade that moves it cannot ship a Worker without the classes.
 */
const exportEntryClasses = (): Plugin => {
  let injected = false;
  return {
    name: "tstodon:export-entry-classes",
    enforce: "post",
    transform(code, id) {
      if (!id.split("?")[0]?.endsWith("/.void/entry.ts")) {
        return null;
      }
      injected = true;
      return { code: `${code}\nexport * from ${JSON.stringify(entryClassesFile)};\n`, map: null };
    },
    buildEnd(error) {
      const workerBuild =
        this.environment.mode === "build" && this.environment.config.consumer === "server";
      if (!error && workerBuild && !injected) {
        this.error(
          "Void's generated .void/entry.ts was not built; Workflow and DO classes are missing",
        );
      }
    },
  };
};

export default defineConfig({
  // Workers static assets come from Vite's public directory (the client build).
  publicDir: "assets",
  ...(persistTo ? { cacheDir: path.join(persistTo, "vite") } : {}),
  plugins: [
    // Keep local state where `wrangler ... --local` reads and writes it.
    voidPlugin({ persistTo: persistTo ?? ".wrangler/state" }),
    exportEntryClasses(),
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
            wrangler: { configPath: "./wrangler.jsonc" },
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
