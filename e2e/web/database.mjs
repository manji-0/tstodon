// The browser e2e suite's migrated D1 database. Wrangler applies each migration
// in its own step, which takes most of a minute on a busy machine, so the
// result is kept under .cache, named by the e2e config, the migrations and the
// Wrangler version it was built from. `pnpm e2e:web` runs this file before
// Playwright, so the web server's start-up budget does not have to cover the
// migrations.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const config = "e2e/web.wrangler.jsonc";
const migrations = path.join(root, "packages/worker/app/db/migrations");

const cache = path.join(root, ".cache/e2e-web/d1");

/** Names the database by what builds it: the e2e config, the migrations and Wrangler's version. */
const digest = () => {
  const hash = createHash("sha256");
  const add = (name, content) => hash.update(`${name}\0`).update(content).update("\0");
  add(config, readFileSync(path.join(root, config)));
  add("wrangler", readFileSync(path.join(root, "node_modules/wrangler/package.json")));
  for (const file of readdirSync(migrations).sort()) {
    add(file, readFileSync(path.join(migrations, file)));
  }
  return hash.digest("hex").slice(0, 16);
};

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Drops databases of other digests and builds whose process has exited. */
const removeStale = (current) => {
  for (const name of readdirSync(cache)) {
    const [, pid] = name.split(".");
    if (name !== current && !(pid && isRunning(Number(pid)))) {
      rmSync(path.join(cache, name), { recursive: true, force: true });
    }
  }
};

/** The `--persist-to` directory of a database with every migration applied. */
export const migratedDatabase = () => {
  const name = digest();
  const template = path.join(cache, name);
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
  try {
    renameSync(building, template);
  } catch (error) {
    // Another run built the same database first.
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") {
      throw error;
    }
    rmSync(building, { recursive: true, force: true });
  }
  removeStale(name);
  return template;
};

if (import.meta.main) {
  migratedDatabase();
}
