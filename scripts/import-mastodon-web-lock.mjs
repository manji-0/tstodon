#!/usr/bin/env node
// Lock packages/web's dependencies at the versions upstream Mastodon's
// yarn.lock resolved, instead of whatever is newest when pnpm resolves them.
//
//   node scripts/import-mastodon-web-lock.mjs path/to/mastodon/yarn.lock
//
// `pnpm import` turns that yarn.lock into a pnpm lockfile for
// packages/web/package.json alone (in .cache/mastodon-web-lock/). This script
// then puts its importer into the workspace's pnpm-lock.yaml as
// `packages/web`, adds the package and snapshot entries the workspace lock
// lacks (an entry the workspace already has stays as it is), drops entries no
// importer reaches any more, and installs with --frozen-lockfile, which
// fails if the result does not satisfy every package.json. Run `pnpm install`
// afterwards: it should report the lockfile up to date.
// See docs/operations/mastodon-web-upstream.md.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yarnLock = process.argv[2];
if (!yarnLock) {
  console.error("Usage: node scripts/import-mastodon-web-lock.mjs path/to/mastodon/yarn.lock");
  process.exit(1);
}

const work = path.join(root, ".cache", "mastodon-web-lock");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
copyFileSync(path.join(root, "packages", "web", "package.json"), path.join(work, "package.json"));
copyFileSync(path.resolve(yarnLock), path.join(work, "yarn.lock"));
// A workspace of its own, so pnpm does not treat it as part of this one.
writeFileSync(path.join(work, "pnpm-workspace.yaml"), "packages: []\n");
execFileSync("pnpm", ["import"], { cwd: work, stdio: "inherit" });

/**
 * A pnpm lockfile document as its top-level sections, each a list of
 * entries: a two-space-indented key line and the lines under it.
 */
const parseDocument = (text) => {
  const sections = [];
  let section;
  let entry;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = { head: line, entries: [], extra: [] };
      sections.push(section);
      entry = undefined;
    } else if (section && /^ {2}\S/.test(line)) {
      // `  key:` or `  key: {}`; keys hold no `: `.
      entry = { key: unquote(line.trim().replace(/:(?: .*)?$/, "")), lines: [line] };
      section.entries.push(entry);
    } else if (entry && line !== "") {
      entry.lines.push(line);
    } else if (section && !entry && line !== "") {
      section.extra.push(line);
    }
  }
  return sections;
};

const unquote = (text) => text.replace(/^'(.*)'$/, "$1");

const WIDE = ["importers:", "packages:", "snapshots:"];

const formatDocument = (sections) =>
  sections
    .map(({ head, entries, extra }) => {
      const block = [head, ...extra];
      for (const { lines } of entries) {
        if (WIDE.includes(head)) block.push("");
        block.push(...lines);
      }
      return block.join("\n");
    })
    .join("\n\n");

/** The snapshot key a `name: version` dependency line points at, or undefined for a link. */
const snapshotKey = (name, version) => {
  const v = unquote(version);
  if (v.startsWith("link:") || v.startsWith("file:")) return undefined;
  // An alias (`emoji-mart: emoji-mart-lazyload@3.0.1-j`) names the package itself.
  return v.split("(")[0].includes("@") ? v : `${name}@${v}`;
};

/** The snapshot keys an entry depends on: `version:` lines of importers, `name: version` lines of snapshots. */
const dependenciesOf = (entry, importer) => {
  const keys = [];
  let name;
  for (const line of entry.lines.slice(1)) {
    if (importer) {
      const dep = /^ {6}(\S.*):$/.exec(line);
      if (dep) name = unquote(dep[1]);
      const version = /^ {8}version: (.+)$/.exec(line);
      if (version && name) keys.push(snapshotKey(name, version[1]));
    } else {
      const dep = /^ {6}('[^']+'|[^:\s]+): (.+)$/.exec(line);
      if (dep) keys.push(snapshotKey(unquote(dep[1]), dep[2]));
    }
  }
  return keys.filter(Boolean);
};

const lockPath = path.join(root, "pnpm-lock.yaml");
const lockText = readFileSync(lockPath, "utf8");
// The workspace lock holds pnpm's own entry first, then the workspace's.
const split = lockText.lastIndexOf("\n---\n");
const prefix = split === -1 ? "" : lockText.slice(0, split + 5);
const workspace = parseDocument(split === -1 ? lockText : lockText.slice(split + 5));
const imported = parseDocument(readFileSync(path.join(work, "pnpm-lock.yaml"), "utf8"));

const section = (sections, head) => {
  const found = sections.find((s) => s.head === head);
  if (!found) throw new Error(`Lockfile has no ${head}`);
  return found;
};

const importers = section(workspace, "importers:");
const webImporter = section(imported, "importers:").entries.find((e) => e.key === ".");
if (!webImporter) throw new Error("pnpm import wrote no importer");
importers.entries = [
  ...importers.entries.filter((e) => e.key !== "packages/web"),
  { key: "packages/web", lines: ["  packages/web:", ...webImporter.lines.slice(1)] },
];

for (const head of ["packages:", "snapshots:"]) {
  const target = section(workspace, head);
  const have = new Map(target.entries.map((e) => [e.key, e]));
  for (const entry of section(imported, head).entries) {
    const existing = have.get(entry.key);
    if (!existing) {
      target.entries.push(entry);
    } else if (
      existing.lines.includes("    optional: true") &&
      !entry.lines.includes("    optional: true")
    ) {
      // A snapshot packages/web needs is not optional, whatever else uses it.
      existing.lines = existing.lines.filter((line) => line !== "    optional: true");
      if (existing.lines.length === 1)
        existing.lines = [`${existing.lines[0].replace(/:$/, "")}: {}`];
    }
  }
}

// Keep what the importers reach; pnpm sorts each section by key.
const snapshots = section(workspace, "snapshots:");
const packages = section(workspace, "packages:");
const byKey = new Map(snapshots.entries.map((e) => [e.key, e]));
const reached = new Set();
const queue = importers.entries.flatMap((e) => dependenciesOf(e, true));
while (queue.length > 0) {
  const key = queue.pop();
  if (reached.has(key)) continue;
  reached.add(key);
  const entry = byKey.get(key);
  if (!entry) throw new Error(`Lockfile has no snapshot ${key}`);
  queue.push(...dependenciesOf(entry, false));
}
const packageOf = (key) => key.replace(/\(.*$/, "");
const reachedPackages = new Set([...reached].map(packageOf));
snapshots.entries = snapshots.entries.filter((e) => reached.has(e.key));
packages.entries = packages.entries.filter((e) => reachedPackages.has(e.key));
const compare = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
for (const s of [importers, packages, snapshots]) s.entries.sort(compare);

writeFileSync(lockPath, `${prefix}${formatDocument(workspace)}\n`);
console.log(`Locked packages/web from ${path.relative(root, path.resolve(yarnLock))}`);

execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
rmSync(work, { recursive: true, force: true });
