// The browser e2e suite's migrated D1 database. Wrangler applies each migration
// in its own step, which takes most of a minute on a busy machine, so the
// result is kept under .cache, named by the e2e config and the migrations it
// was built from. `pnpm e2e:web` runs this file before Playwright, so the web
// server's start-up budget does not have to cover the migrations.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const config = "e2e/web.wrangler.jsonc";
const migrations = path.join(root, "packages/worker/app/db/migrations");

const digest = () => {
  const hash = createHash("sha256").update(readFileSync(path.join(root, config)));
  for (const file of readdirSync(migrations).sort()) {
    hash.update(file).update(readFileSync(path.join(migrations, file)));
  }
  return hash.digest("hex").slice(0, 16);
};

/** The `--persist-to` directory of a database with every migration applied. */
export const migratedDatabase = () => {
  const template = path.join(root, ".cache/e2e-web/d1", digest());
  if (existsSync(template)) {
    return template;
  }
  const building = `${template}.${process.pid}`;
  rmSync(building, { recursive: true, force: true });
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "tstodon-e2e-web",
      "--local",
      "--config",
      config,
      "--persist-to",
      building,
    ],
    { cwd: root, stdio: "inherit" },
  );
  renameSync(building, template);
  return template;
};

if (import.meta.main) {
  migratedDatabase();
}
