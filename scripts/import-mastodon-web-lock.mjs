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
// project, adds the package entries the workspace lock lacks (an entry it
// already has stays as it is), drops entries no project reaches any more, and
// runs `pnpm install` (which settles peer suffixes, keeping the
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
const HOISTED = ["browserslist", "tesseract.js-core", "jsdom", "redux"];
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
const rootPackage = readJson(path.join(root, "package.json"));
const frontendPackage = {
  name: "mastodon-web-lock",
  private: true,
  // The workspace's pnpm, which writes the workspace's lockfile format.
  packageManager: rootPackage.packageManager,
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
  workspaceYaml
    .replace(/^packages:\n(?: {2}- .*\n)+/m, "packages: []\n")
    // The workspace's patches are for packages the frontend does not use.
    .replace(/^patchedDependencies:\n(?: {2}.*\n)+/m, ""),
);
execFileSync("pnpm", ["import"], { cwd: work, stdio: "inherit" });

/**
 * A v13 lockfile document. pnpm writes it as JSON with a trailing comma after
 * every entry (still YAML); dropping those commas leaves plain JSON. No
 * lockfile string holds a comma before a closing bracket.
 */
const parseDocument = (text) => JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));

const lockPath = path.join(root, "pnpm-lock.yaml");
const lockText = readFileSync(lockPath, "utf8");
// The workspace lock holds pnpm's own entry first, then the workspace's.
const split = lockText.lastIndexOf("\n---\n");
const prefix = split === -1 ? "" : lockText.slice(0, split + 5);
const workspace = parseDocument(split === -1 ? lockText : lockText.slice(split + 5));
const importedText = readFileSync(path.join(work, "pnpm-lock.yaml"), "utf8");
const imported = parseDocument(importedText.slice(importedText.lastIndexOf("\n---\n") + 5));
for (const [name, document] of [
  ["pnpm-lock.yaml", workspace],
  ["the imported lock", imported],
]) {
  if (document.lockfileVersion !== "13.0") {
    throw new Error(`${name} is lockfile ${document.lockfileVersion}; set lockfile.format: v13`);
  }
}

const workerProject = workspace.projects["packages/worker"];
const frontendProject = imported.projects["."];
if (!workerProject) throw new Error("Lockfile has no packages/worker project");
if (!frontendProject) throw new Error("pnpm import wrote no project");

// The frontend's dependencies take the versions pnpm import locked.
for (const [group, deps] of Object.entries(workerProject)) {
  if (typeof deps !== "object") continue;
  for (const name of Object.keys(deps)) {
    if (!frontendNames.has(name)) continue;
    const locked = frontendProject[group]?.[name];
    if (locked === undefined) throw new Error(`pnpm import locked no ${group} ${name}`);
    deps[name] = locked;
  }
}

// Add the package versions the workspace lock lacks; an entry it has stays.
for (const [key, entry] of Object.entries(imported.packages)) {
  const existing = workspace.packages[key];
  if (!existing) {
    workspace.packages[key] = entry;
  } else if (existing.optional && !entry.optional) {
    // A package the frontend needs is not optional, whatever else uses it.
    delete existing.optional;
  }
}

/** The package key a dependency resolves to, or undefined for a workspace link. */
const packageKey = (name, version) => {
  if (version.startsWith("link:") || version.startsWith("file:")) return undefined;
  if (version.startsWith("workspace:")) return undefined;
  const plain = version.replace(/^npm:/, "");
  // An alias (`emoji-mart-lazyload@3.0.1-j`) names the package itself.
  return /^(@[^/]+\/)?[^@]+@/.test(plain) ? plain : `${name}@${plain}`;
};
/** The version a project's dependency resolves to: a plain version, `{specifier, version}`, or a catalog entry. */
const projectVersion = (name, value) => {
  if (typeof value === "object") return value.version;
  if (value.startsWith("catalog:")) {
    const catalogName = value.slice("catalog:".length) || "default";
    return workspace.settings?.catalogs?.[catalogName]?.[name];
  }
  return value;
};
/** The package keys a package entry depends on, its peers in every snapshot included. */
const dependenciesOf = (entry) => {
  const keys = [];
  const add = (name, version) => {
    const key = version === undefined ? undefined : packageKey(name, version);
    if (key) keys.push(key);
  };
  for (const variant of [entry, ...(entry.snapshots ?? [])]) {
    for (const group of ["dependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(variant[group] ?? {})) add(name, version);
    }
    for (const [name, peer] of Object.entries(variant.peerDependencies ?? {})) {
      add(name, peer.version);
    }
  }
  return keys;
};

// Keep what the projects reach; pnpm sorts each section by key.
const reached = new Set();
const queue = Object.values(workspace.projects).flatMap((project) =>
  Object.values(project)
    .filter((deps) => typeof deps === "object")
    .flatMap((deps) =>
      Object.entries(deps).flatMap(([name, value]) => {
        const version = projectVersion(name, value);
        const key = version === undefined ? undefined : packageKey(name, version);
        return key ? [key] : [];
      }),
    ),
);
while (queue.length > 0) {
  const key = queue.pop();
  if (reached.has(key)) continue;
  reached.add(key);
  const entry = workspace.packages[key];
  if (!entry) throw new Error(`Lockfile has no package ${key}`);
  queue.push(...dependenciesOf(entry));
}
const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
workspace.packages = Object.fromEntries(
  Object.entries(workspace.packages)
    .filter(([key]) => reached.has(key))
    .sort(([a], [b]) => compareKeys(a, b)),
);

// pnpm install below rewrites the lock in its own layout.
writeFileSync(lockPath, `${prefix}${JSON.stringify(workspace, null, "\t")}\n`);
console.log(
  `Locked the Mastodon frontend's dependencies from ${path.relative(root, path.resolve(yarnLock))}`,
);

execFileSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
rmSync(work, { recursive: true, force: true });
