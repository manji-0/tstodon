import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";
import {
  LOCAL_ACCESS_AUD,
  LOCAL_ACCESS_JWKS_JSON,
  LOCAL_ACCESS_TEAM_DOMAIN,
} from "./packages/worker/test/access-jwt-fixture";
import { webManifest } from "./packages/worker/web-build";

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "packages/worker/app/db/migrations"),
);

export default defineConfig({
  test: {
    // Each project gets its own Vite server and ignores the root config.
    sharedViteServer: false,
    projects: [
      {
        extends: false,
        test: {
          name: "domain",
          include: [
            "packages/core/src/**/*.test.ts",
            "packages/domain/src/**/*.test.ts",
            "packages/api/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        extends: false,
        plugins: [
          // `server/web-manifest.ts` imports the client build's entry files.
          webManifest({ source: "build" }),
          cloudflareTest({
            // The build output: tests run the Worker Void generates, so build
            // `packages/worker` first (`pnpm test` does).
            wrangler: { configPath: "./packages/worker/dist/ssr/wrangler.json" },
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
                // Test-only Better Auth signing secret (example.com is not a
                // local host, so Void's dev fallback does not apply).
                BETTER_AUTH_SECRET: "tstodon-test-only-better-auth-secret-0123456789",
                // Test-only Cloudflare Access trust (public key). The matching
                // private key lives in the test fixture and signs assertions.
                CF_ACCESS_TEAM_DOMAIN: LOCAL_ACCESS_TEAM_DOMAIN,
                CF_ACCESS_AUD: LOCAL_ACCESS_AUD,
                CF_ACCESS_JWKS_JSON: LOCAL_ACCESS_JWKS_JSON,
                // Leave CF_ACCESS_ADMIN_GROUPS unset. A non-empty list is the
                // role on every Access login, which would undo a role a test
                // sets on the user row.
                // Sign-up mail lands in APP_CACHE, where tests read the link.
                EMAIL_TRANSPORT: "capture",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          // Integration tests run in workerd; under a full parallel run the
          // longer request chains need more than Vitest's 5s default.
          testTimeout: 15_000,
          include: ["packages/worker/server/**/*.test.ts"],
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
      "packages/worker/.void/**",
      "packages/worker/.wrangler/**",
      "pnpm-lock.yaml",
      "**/worker-configuration.d.ts",
      // Mastodon's vendored frontend and its Vite plugins keep upstream's
      // formatting; see packages/worker/src/UPSTREAM.md.
      "packages/worker/src/**",
      "packages/worker/config/**",
      "packages/worker/public/**",
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
      "packages/worker/.void/**",
      "packages/worker/.wrangler/**",
      "e2e/instances/.wrangler/**",
      "**/worker-configuration.d.ts",
      // Prisma's generated client and TypedSQL modules cast internally.
      "packages/worker/server/generated/**",
      // Mastodon's vendored frontend and its Vite plugins (upstream's code;
      // `pnpm typecheck:web` checks their types).
      "packages/worker/src/**",
      "packages/worker/config/**",
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
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      // `any` (from `JSON.parse`, `Response.json()`, ...) would carry an
      // unparsed value past the assertion rule above.
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      {
        // Test matchers (`expect.any`, `expect.objectContaining`) are typed
        // `any`, and the build scripts are untyped JavaScript.
        files: ["**/*.test.ts", "**/*.spec.ts", "packages/worker/test/**", "e2e/**", "scripts/**"],
        rules: {
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
    ],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
});
