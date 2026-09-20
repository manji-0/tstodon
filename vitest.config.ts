import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["packages/worker/src/**/*.test.ts"],
        },
      },
    ],
  },
});
