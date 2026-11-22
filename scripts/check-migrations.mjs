#!/usr/bin/env node
// Runs Void's own deploy gate over the D1 migrations: a migration that drops
// a table, view, index or trigger, renames, truncates, or writes without a
// WHERE needs a standalone `-- void:allow-destructive` line, or
// `pnpm run deploy` refuses it. Void does not export the check under a stable
// name, so this finds the module that carries it in Void's build and fails
// loudly when an upgrade moves it.
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS = "packages/worker/app/db/migrations";

const voidDist = path.join(await realpath("packages/worker/node_modules/void"), "dist");

const findValidateMigrations = async () => {
  for (const name of (await readdir(voidDist)).filter((file) => file.endsWith(".mjs"))) {
    const file = path.join(voidDist, name);
    if (!(await readFile(file, "utf8")).includes("Destructive migrations detected")) continue;
    const module = await import(pathToFileURL(file).href);
    for (const value of Object.values(module)) {
      if (value && typeof value.validateMigrations === "function") {
        return value.validateMigrations;
      }
    }
  }
  return undefined;
};

const validateMigrations = await findValidateMigrations();
if (!validateMigrations) {
  console.error(`check-migrations: Void's validateMigrations was not found in ${voidDist}`);
  process.exit(1);
}

const directory = process.argv[2] ?? MIGRATIONS;
const files = await Promise.all(
  (await readdir(directory))
    .filter((name) => name.endsWith(".sql") && name !== "seed.sql")
    .sort()
    .map(async (name) => ({ name, sql: await readFile(path.join(directory, name), "utf8") })),
);
try {
  validateMigrations(files);
} catch (error) {
  console.error(`check-migrations: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
