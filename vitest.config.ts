import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations"),
);

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "domain",
          include: [
            "packages/core/src/**/*.test.ts",
            "packages/domain/src/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
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
          include: ["packages/worker/src/**/*.test.ts"],
          setupFiles: ["./packages/worker/test/apply-migrations.ts"],
        },
      },
    ],
  },
});
