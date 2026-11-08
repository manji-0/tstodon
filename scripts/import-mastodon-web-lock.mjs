#!/usr/bin/env node
// Lock the Mastodon frontend's dependencies (in packages/worker/package.json,
// beside the Worker's own) at the versions upstream Mastodon's yarn.lock
// resolved, instead of whatever is newest when pnpm resolves them.
//
//   node scripts/import-mastodon-web-lock.mjs path/to/mastodon/yarn.lock path/to/mastodon/package.json
//
// The frontend's dependencies are the entries of packages/worker/package.json
// that upstream's package.json declares, plus the few tstodon declares because
// upstream relies on Yarn hoisting for them (HOISTED below; see
// packages/worker/src/UPSTREAM.md). `pnpm import` turns the yarn.lock into a
// pnpm lockfile for those alone, at packages/worker/package.json's versions,
// in .cache/mastodon-web-lock/, with the workspace's settings (catalog,
// overrides: Vite and Vitest stay the workspace's). This script then replaces
// those dependencies' entries in the workspace lock's `packages/worker`
// importer, adds the package and snapshot entries the workspace lock lacks (an
// entry it already has stays as it is), drops entries no importer reaches any
// more, and runs `pnpm install` (which settles peer suffixes, keeping the
// locked versions) and `pnpm install --frozen-lockfile`.
// See docs/operations/mastodon-web-upstream.md.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [yarnLock, upstreamPackageJson] = process.argv.slice(2);
if (!yarnLock || !upstreamPackageJson) {
  console.error(
    "Usage: node scripts/import-mastodon-web-lock.mjs path/to/mastodon/yarn.lock path/to/mastodon/package.json",
  );
  process.exit(1);
}

/** Packages upstream uses without declaring them (Yarn hoists them); tstodon declares them. */
const HOISTED = ["browserslist", "tesseract.js-core", "@types/history", "jsdom", "redux"];
/** The workspace's own: Vite+ core and Vitest from the catalog. */
const WORKSPACE_OWNED = ["vite", "vitest"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const upstream = readJson(path.resolve(upstreamPackageJson));
const worker = readJson(path.join(root, "packages", "worker", "package.json"));
const upstreamNames = new Set([
  ...Object.keys(upstream.dependencies ?? {}),
  ...Object.keys(upstream.devDependencies ?? {}),
  ...HOISTED,
]);
const frontend = (deps = {}) =>
  Object.fromEntries(
    Object.entries(deps).filter(
      ([name]) => upstreamNames.has(name) && !WORKSPACE_OWNED.includes(name),
    ),
  );
const catalog = (name) => {
  const entry = new RegExp(`^ {2}${name}: (.+)$`, "m").exec(
    readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  if (!entry?.[1]) throw new Error(`pnpm-workspace.yaml has no catalog entry ${name}`);
  return entry[1].trim();
};
const frontendPackage = {
  name: "mastodon-web-lock",
  private: true,
  dependencies: frontend(worker.dependencies),
  // Vite+ core and Vitest as the workspace has them, so upstream's Vite
  // plugins resolve their peers to those and not to upstream's Vite.
  devDependencies: {
    ...frontend(worker.devDependencies),
    vite: catalog("vite"),
    vitest: catalog("vitest"),
  },
};
const frontendNames = new Set([
  ...Object.keys(frontendPackage.dependencies),
  ...Object.keys(frontendPackage.devDependencies),
]);

const work = path.join(root, ".cache", "mastodon-web-lock");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(path.join(work, "package.json"), `${JSON.stringify(frontendPackage, null, 2)}\n`);
copyFileSync(path.resolve(yarnLock), path.join(work, "yarn.lock"));
// A workspace of its own, so pnpm does not treat it as part of this one, with
// this workspace's settings.
const workspaceYaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
writeFileSync(
  path.join(work, "pnpm-workspace.yaml"),
  workspaceYaml.replace(/^packages:\n(?: {2}- .*\n)+/m, "packages: []\n"),
);
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
const workerImporter = importers.entries.find((e) => e.key === "packages/worker");
const frontendImporter = section(imported, "importers:").entries.find((e) => e.key === ".");
if (!workerImporter) throw new Error("Lockfile has no packages/worker importer");
if (!frontendImporter) throw new Error("pnpm import wrote no importer");

/**
 * An importer's dependency blocks by group (`dependencies`, `devDependencies`):
 * a six-space `name:` line and the specifier and version lines under it.
 */
const importerGroups = (entry) => {
  const groups = new Map();
  let group;
  let block;
  for (const line of entry.lines.slice(1)) {
    const groupHead = /^ {4}(\S+):$/.exec(line);
    if (groupHead) {
      group = new Map();
      groups.set(groupHead[1], group);
      continue;
    }
    const name = /^ {6}(\S.*):$/.exec(line);
    if (name && group) {
      block = [line];
      group.set(unquote(name[1]), block);
    } else if (block) {
      block.push(line);
    }
  }
  return groups;
};

const workerGroups = importerGroups(workerImporter);
const frontendGroups = importerGroups(frontendImporter);
for (const [groupName, group] of workerGroups) {
  for (const name of group.keys()) {
    if (!frontendNames.has(name)) continue;
    const locked = frontendGroups.get(groupName)?.get(name);
    if (!locked) throw new Error(`pnpm import locked no ${groupName} ${name}`);
    group.set(name, locked);
  }
}
const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
workerImporter.lines = [
  workerImporter.lines[0],
  ...[...workerGroups].flatMap(([groupName, group]) => [
    `    ${groupName}:`,
    ...[...group].sort(([a], [b]) => compareKeys(a, b)).flatMap(([, block]) => block),
  ]),
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
      // A snapshot the frontend needs is not optional, whatever else uses it.
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
console.log(
  `Locked the Mastodon frontend's dependencies from ${path.relative(root, path.resolve(yarnLock))}`,
);

execFileSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
rmSync(work, { recursive: true, force: true });
