#!/usr/bin/env node
// Build Mastodon's own web UI (its React app under app/javascript) and place
// the output in packages/worker/assets, which Void serves as Workers Assets.
//
// The Mastodon source is fetched at a pinned release (MASTODON_WEB_REF,
// default below) into .cache/mastodon-web/<ref>, built with Mastodon's Vite
// config, and copied without sourcemaps or precompressed files. The Worker
// renders the HTML shell itself (src/web-app.ts) from packs/tstodon-web.json,
// the compact manifest this script writes.
//
// Mastodon is AGPL-3.0-or-later, as tstodon is; the build output carries its
// license notices.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REF = "v4.7.3";
const REPOSITORY = "https://github.com/mastodon/mastodon.git";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ref = process.env.MASTODON_WEB_REF ?? DEFAULT_REF;
const source = path.join(root, ".cache", "mastodon-web", ref);
const assets = path.join(root, "packages", "worker", "assets");

const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });

if (!existsSync(path.join(source, "package.json"))) {
  rmSync(source, { recursive: true, force: true });
  mkdirSync(path.dirname(source), { recursive: true });
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    ref,
    "--filter=blob:none",
    "--sparse",
    REPOSITORY,
    source,
  ]);
  // The frontend, its Vite plugins and configs, and the static files it uses.
  run(
    "git",
    ["sparse-checkout", "set", "app/javascript", "config", "public", "lib/javascript", "streaming"],
    source,
  );
}

run("corepack", ["yarn", "install", "--immutable"], source);
run("corepack", ["yarn", "build:production"], source);

const publicDir = path.join(source, "public");
const packs = path.join(publicDir, "packs");
const keep = (file) => !file.endsWith(".map") && !file.endsWith(".gz");

// Generated directories are replaced wholesale; see the .gitignore entries.
for (const generated of ["packs", "emoji", "sounds"]) {
  rmSync(path.join(assets, generated), { recursive: true, force: true });
}
cpSync(packs, path.join(assets, "packs"), {
  recursive: true,
  filter: (from) => keep(from) && !from.includes(`${path.sep}.vite`),
});
cpSync(path.join(publicDir, "emoji"), path.join(assets, "emoji"), { recursive: true });
cpSync(path.join(publicDir, "sounds"), path.join(assets, "sounds"), { recursive: true });
for (const file of readdirSync(publicDir)) {
  if (/^(sw\.js|badge\.png|loading\.(gif|png)|oops\.(gif|png)|web-push-icon_.*\.png)$/.test(file)) {
    cpSync(path.join(publicDir, file), path.join(assets, file));
  }
}

// The compact manifest the Worker renders <script>/<link> tags from.
const manifest = JSON.parse(readFileSync(path.join(packs, ".vite", "manifest.json"), "utf8"));
const url = (file) => `/packs/${file}`;

/** An entry's file, the CSS it and its static imports pull in, and the chunks to preload. */
const entry = (key) => {
  const start = manifest[key];
  if (!start) {
    throw new Error(`Vite manifest has no entry ${key}`);
  }
  const css = new Set();
  const preload = new Set();
  const seen = new Set();
  const walk = (chunkKey, top) => {
    if (seen.has(chunkKey)) return;
    seen.add(chunkKey);
    const chunk = manifest[chunkKey];
    if (!chunk) return;
    for (const sheet of chunk.css ?? []) css.add(url(sheet));
    if (!top) preload.add(url(chunk.file));
    for (const imported of chunk.imports ?? []) walk(imported, false);
  };
  walk(key, true);
  return { js: url(start.file), css: [...css], preload: [...preload] };
};

const locales = readdirSync(path.join(source, "app", "javascript", "mastodon", "locales"))
  .filter((file) => /^[a-zA-Z-]+\.json$/.test(file))
  .map((file) => file.replace(/\.json$/, ""))
  .sort();

const compact = {
  ref,
  polyfills: url(manifest["../../vite/legacy-polyfills"].file),
  themeSelection: url(manifest["entrypoints/theme-selection.ts"].file),
  inert: url(manifest["styles/entrypoints/inert.scss"].file),
  theme: url(manifest["styles/application.scss"].file),
  common: entry("entrypoints/common.ts"),
  application: entry("entrypoints/application.ts"),
  locales,
};
writeFileSync(
  path.join(assets, "packs", "tstodon-web.json"),
  `${JSON.stringify(compact, null, 2)}\n`,
);
console.log(`Mastodon web ${ref} written to ${path.relative(root, assets)}`);
