#!/usr/bin/env node
// Fails when runtime code passes a type argument to a D1 result method
// (`.all<T>()`, `.first<T>()`, `.raw<T>()`): the argument is an unchecked
// cast the `consistent-type-assertions` rule cannot see. Parse rows with a
// Zod schema instead (`parseRows`, `schemaResult`). Tests and generated code
// are not checked.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOTS = [
  "packages/core/src",
  "packages/domain/src",
  "packages/worker/src",
  "packages/worker/app",
];
const SKIPPED_DIRECTORIES = new Set(["generated", "node_modules"]);
const TYPED_RESULT_CALL = /(?<!Promise)\.(all|first|raw)<[^()]*?>\s*\(/g;

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(full);
      }
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    }),
  );
  return nested.flat();
};

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const findings = [];
for (const file of (await Promise.all(ROOTS.map(sourceFiles))).flat()) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(TYPED_RESULT_CALL)) {
    findings.push(`${file}:${lineOf(text, match.index)}: .${match[1]}<…>() is an unchecked cast`);
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  console.error(
    `\n${findings.length} D1 result call(s) take a type argument. Parse the rows with a Zod schema (parseRows / schemaResult) instead.`,
  );
  process.exit(1);
}
