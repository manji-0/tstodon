import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";

const resolveLocalD1 = (): string => {
  if (process.env.PRISMA_D1_URL) {
    return process.env.PRISMA_D1_URL;
  }
  const dir = path.resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!fs.existsSync(dir)) {
    throw new Error(
      "Local D1 sqlite not found. Run: pnpm exec wrangler d1 migrations apply tstodon --local",
    );
  }
  const file = fs
    .readdirSync(dir)
    .find((name) => name.endsWith(".sqlite") && !name.includes("metadata"));
  if (!file) {
    throw new Error(
      "Local D1 sqlite not found. Run: pnpm exec wrangler d1 migrations apply tstodon --local",
    );
  }
  return `file:${path.join(dir, file)}`;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  typedSql: {
    path: "./prisma/sql",
  },
  datasource: {
    url: resolveLocalD1(),
  },
});
