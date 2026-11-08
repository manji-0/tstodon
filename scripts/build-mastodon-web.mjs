#!/usr/bin/env node
// Build Mastodon's web UI (the React app vendored in packages/web) and place
// the output in packages/worker/assets, which Void serves as Workers Assets.
//
// packages/web is Mastodon's frontend at the release named in
// packages/web/upstream.json, with tstodon's changes (see UPSTREAM.md there).
// The large static trees upstream keeps in public/ (`fetched` in
// upstream.json: twemoji SVGs and Tesseract language data) are not committed:
// they are fetched from that upstream commit into
// .cache/mastodon-web/upstream/<commit>/ and linked into packages/web/public/.
// The frontend is built with Mastodon's Vite config through pnpm and copied
// without sourcemaps or precompressed files. The Worker renders the HTML shell
// itself (src/web-app.ts) from packs/tstodon-web.json, the compact manifest
// this script writes.
//
// A build takes about half a minute, so it is skipped when the assets are the
// output of this script for the current sources: `.cache/mastodon-web/
// assets.stamp` holds a digest of every file under packages/web that git
// tracks or does not ignore, the lockfile and workspace settings, this
// script, and the manifest it wrote, and every file that manifest names must
// exist. `--force` rebuilds.
//
// Mastodon is AGPL-3.0-or-later, as tstodon is; the build output carries its
// license notices.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "packages", "web");
const cache = path.join(root, ".cache", "mastodon-web");
const assets = path.join(root, "packages", "worker", "assets");
const compactManifest = path.join(assets, "packs", "tstodon-web.json");
const stamp = path.join(cache, "assets.stamp");

const upstream = z
  .object({
    repository: z.string(),
    tag: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    fetched: z.array(z.string()),
  })
  .parse(JSON.parse(readFileSync(path.join(web, "upstream.json"), "utf8")));

// The upstream release the build is based on, marked as carrying tstodon's changes.
const ref = `${upstream.tag}+tstodon`;
const fetchedRoot = path.join(cache, "upstream", upstream.commit);

const git = (args, cwd = root) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** A digest of what the assets are built from: packages/web as it is on disk, the dependency lock, this script. */
const sourcesDigest = () => {
  const hash = createHash("sha256").update(`${ref}\0${upstream.commit}\0`);
  const files = git([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "packages/web",
  ])
    .split("\0")
    .filter(Boolean);
  for (const file of [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${file}\0`);
    const full = path.join(root, file);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      hash.update("missing\0");
      continue;
    }
    hash.update(stat.isSymbolicLink() ? `link:${readlinkSync(full)}` : readFileSync(full));
    hash.update("\0");
  }
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    hash.update(readFileSync(path.join(root, file))).update("\0");
  }
  return hash.update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
};

/** The digest of the sources and the manifest a build wrote from them, or undefined before a build. */
const assetsDigest = (sources) =>
  existsSync(compactManifest)
    ? createHash("sha256")
        .update(`${sources}\0`)
        .update(readFileSync(compactManifest))
        .digest("hex")
    : undefined;

const EntrySchema = z.object({
  js: z.string(),
  css: z.array(z.string()),
  preload: z.array(z.string()),
});
const CompactManifestSchema = z.object({
  ref: z.literal(ref),
  polyfills: z.string(),
  themeSelection: z.string(),
  inert: z.string(),
  theme: z.string(),
  favicon: z.string(),
  common: EntrySchema,
  application: EntrySchema,
  remoteInteractionHelper: EntrySchema,
  locales: z.array(z.string()),
});

/** Every file the compact manifest names, and the static files copied beside packs/, exist. */
const assetsPresent = () => {
  let json;
  try {
    json = JSON.parse(readFileSync(compactManifest, "utf8"));
  } catch {
    return false;
  }
  const parsed = CompactManifestSchema.safeParse(json);
  if (!parsed.success) {
    return false;
  }
  const m = parsed.data;
  const files = [
    ...[m.polyfills, m.themeSelection, m.inert, m.theme, m.favicon],
    ...[m.common, m.application, m.remoteInteractionHelper].flatMap((entry) => [
      entry.js,
      ...entry.css,
      ...entry.preload,
    ]),
  ].map((url) => url.replace(/^\//, ""));
  return [...files, "emoji", "sounds", "sw.js"].every((file) =>
    existsSync(path.join(assets, file)),
  );
};

const sources = sourcesDigest();
if (
  !process.argv.includes("--force") &&
  existsSync(stamp) &&
  readFileSync(stamp, "utf8") === assetsDigest(sources) &&
  assetsPresent()
) {
  console.log(`Mastodon web ${ref} is up to date in ${path.relative(root, assets)}`);
  process.exit(0);
}

const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });

/**
 * Fetches upstream's `fetched` paths at the pinned commit into fetchedRoot: a
 * shallow, blob-filtered, sparse fetch of the tag, which must point at the
 * recorded commit. Only the checked-out files are kept.
 */
const fetchUpstreamAssets = () => {
  const marker = path.join(fetchedRoot, ".complete");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === upstream.commit) {
    return;
  }
  const staging = `${fetchedRoot}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(fetchedRoot, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  console.log(`Fetching ${upstream.fetched.join(", ")} from Mastodon ${upstream.tag}`);
  run("git", ["init", "--quiet"], staging);
  run("git", ["remote", "add", "origin", upstream.repository], staging);
  run(
    "git",
    ["sparse-checkout", "set", "--no-cone", ...upstream.fetched.map((p) => `/${p}/`)],
    staging,
  );
  run(
    "git",
    [
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "--filter=blob:none",
      "origin",
      `refs/tags/${upstream.tag}`,
    ],
    staging,
  );
  const fetched = git(["rev-parse", "FETCH_HEAD^{commit}"], staging).trim();
  if (fetched !== upstream.commit) {
    throw new Error(
      `Mastodon ${upstream.tag} is ${fetched}, but packages/web/upstream.json records ${upstream.commit}`,
    );
  }
  run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", upstream.commit], staging);
  for (const p of upstream.fetched) {
    if (!existsSync(path.join(staging, p))) {
      throw new Error(`Mastodon ${upstream.tag} has no ${p}`);
    }
  }
  rmSync(path.join(staging, ".git"), { recursive: true, force: true });
  writeFileSync(path.join(staging, ".complete"), `${upstream.commit}\n`);
  renameSync(staging, fetchedRoot);
};

/** Links each fetched path into packages/web, where upstream keeps it (gitignored there). */
const linkUpstreamAssets = () => {
  for (const p of upstream.fetched) {
    const link = path.join(web, p);
    rmSync(link, { recursive: true, force: true });
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.relative(path.dirname(link), path.join(fetchedRoot, p)), link, "dir");
  }
};

/** Removes fetched trees of other commits, and the clones the script kept before packages/web. */
const pruneCache = () => {
  for (const entry of readdirSync(path.join(cache, "upstream"))) {
    if (entry !== upstream.commit) {
      rmSync(path.join(cache, "upstream", entry), { recursive: true, force: true });
    }
  }
  for (const entry of readdirSync(cache)) {
    if (entry !== "upstream" && entry !== "assets.stamp") {
      rmSync(path.join(cache, entry), { recursive: true, force: true });
    }
  }
};

fetchUpstreamAssets();
linkUpstreamAssets();
pruneCache();

const publicDir = path.join(web, "public");
const packs = path.join(publicDir, "packs");
// Mastodon's production build keeps old files in its output directory; start
// empty so no stale chunk is copied.
rmSync(packs, { recursive: true, force: true });
run("pnpm", ["--filter", "@tstodon/web", "run", "build:production"]);

const keep = (file) => !file.endsWith(".map") && !file.endsWith(".gz");

// Generated directories are replaced wholesale; see the .gitignore entries.
for (const generated of ["packs", "emoji", "sounds"]) {
  rmSync(path.join(assets, generated), { recursive: true, force: true });
}
cpSync(packs, path.join(assets, "packs"), {
  recursive: true,
  filter: (from) => keep(from) && !from.includes(`${path.sep}.vite`),
});
cpSync(path.join(fetchedRoot, "public", "emoji"), path.join(assets, "emoji"), { recursive: true });
cpSync(path.join(publicDir, "sounds"), path.join(assets, "sounds"), { recursive: true });
for (const file of readdirSync(publicDir)) {
  if (/^(sw\.js|badge\.png|web-push-icon_.*\.png)$/.test(file)) {
    // `sw.js` is a symlink into packs/ in the source; copy the file, not the link.
    rmSync(path.join(assets, file), { force: true });
    copyFileSync(path.join(publicDir, file), path.join(assets, file));
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

const locales = readdirSync(path.join(web, "app", "javascript", "mastodon", "locales"))
  .filter((file) => /^[a-zA-Z-]+\.json$/.test(file))
  .map((file) => file.replace(/\.json$/, ""))
  .sort();

const faviconKey = Object.keys(manifest).find((key) => /^_favicon-32x32-.*\.png$/.test(key));
if (!faviconKey) {
  throw new Error("Vite manifest has no 32x32 favicon");
}

const compact = {
  ref,
  polyfills: url(manifest["../../vite/legacy-polyfills"].file),
  themeSelection: url(manifest["entrypoints/theme-selection.ts"].file),
  inert: url(manifest["styles/entrypoints/inert.scss"].file),
  theme: url(manifest["styles/application.scss"].file),
  favicon: url(manifest[faviconKey].file),
  common: entry("entrypoints/common.ts"),
  application: entry("entrypoints/application.ts"),
  // The iframe page of the signed-out interaction modal (/remote_interaction_helper).
  remoteInteractionHelper: entry("entrypoints/remote_interaction_helper.ts"),
  locales,
};
writeFileSync(compactManifest, `${JSON.stringify(compact, null, 2)}\n`);
writeFileSync(stamp, assetsDigest(sources));
console.log(`Mastodon web ${ref} written to ${path.relative(root, assets)}`);
