#!/usr/bin/env node
// Runs Void's own deploy gate over the D1 migrations: a migration that drops
// a table, view, index or trigger, renames, truncates, or writes without a
// WHERE needs a standalone `-- void:allow-destructive` line, or
// `pnpm run deploy` refuses it. Void exports the check only from a module of
// its build (`dist/validate-<hash>.mjs`, which `void deploy` imports), not from
// a public entry point, so this finds the module that exports
// `validateMigrations` by that name and fails loudly when an upgrade moves it.
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS = "packages/worker/app/db/migrations";

const voidDist = path.join(await realpath("packages/worker/node_modules/void"), "dist");

const EXPORTS_VALIDATE_MIGRATIONS = /export\s*\{[^}]*\bvalidateMigrations\s*[,}]/;

const findValidateMigrations = async () => {
  for (const name of (await readdir(voidDist)).filter((file) => file.endsWith(".mjs"))) {
    const file = path.join(voidDist, name);
    if (!EXPORTS_VALIDATE_MIGRATIONS.test(await readFile(file, "utf8"))) continue;
    const module = await import(pathToFileURL(file).href);
    if (typeof module.validateMigrations === "function") return module.validateMigrations;
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
