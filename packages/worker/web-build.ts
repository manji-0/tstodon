// Mastodon's web frontend (`src/`) as the client of this Void app: the parts
// of upstream's `vite.config.mts` the client build and the frontend tests
// need, upstream's own Vite plugins (`config/vite/`, unmodified), and the glue
// that lets the Worker render the HTML shell from the client build. See
// `src/UPSTREAM.md` for the mapping from upstream's files.
import { execFileSync } from "node:child_process";
import {
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
import formatjs from "@formatjs/unplugin/vite";
import { optimizeLodashImports } from "@optimize-lodash/rollup-plugin";
import babel from "@rolldown/plugin-babel";
import legacy from "@vitejs/plugin-legacy";
import react from "@vitejs/plugin-react";
import browserslist from "browserslist";
import postcssPresetEnv from "postcss-preset-env";
import svgr from "vite-plugin-svgr";
import type { Plugin, ResolvedConfig, Rolldown, UserConfig, ViteBuilder } from "vite-plus";
import { z } from "zod";
import { MastodonAssetsManifest } from "./config/vite/plugin-assets-manifest";
import { MastodonThemes } from "./config/vite/plugin-mastodon-themes";
import { MastodonServiceWorkerChunkPaths } from "./config/vite/plugin-sw-chunk-paths";
import { MastodonServiceWorkerLocales } from "./config/vite/plugin-sw-locales";

const workerRoot = import.meta.dirname;
/** Upstream's `app/javascript`: Vite's root there, a directory of this project here. */
export const webRoot = path.join(workerRoot, "src");
const repositoryRoot = path.resolve(workerRoot, "../..");

const UpstreamSchema = z.object({
  repository: z.string(),
  tag: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  imported: z.record(z.string(), z.string()),
  ported: z.record(z.string(), z.string()),
  fetched: z.array(z.string()),
  served: z.array(z.string()),
});

/** `src/upstream.json`: the Mastodon release the frontend is based on. */
export const upstream = UpstreamSchema.parse(
  JSON.parse(readFileSync(path.join(webRoot, "upstream.json"), "utf8")),
);

// ---------------------------------------------------------------------------
// Upstream's static trees that are not committed (`fetched` in upstream.json)

const run = (command: string, args: ReadonlyArray<string>, cwd: string): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/**
 * Fetches upstream's `fetched` paths (twemoji SVGs, Tesseract language data)
 * at the pinned commit into `.cache/mastodon-web/upstream/<commit>/`: a
 * shallow, blob-filtered, sparse fetch of the tag, which must point at the
 * recorded commit. Then links each `served` one into `public/` (gitignored
 * there), so Vite serves it in dev and copies it into the client build.
 * Does nothing when the cache already holds that commit.
 */
export const ensureUpstreamAssets = (): void => {
  const cache = path.join(repositoryRoot, ".cache", "mastodon-web", "upstream");
  const fetchedRoot = path.join(cache, upstream.commit);
  const marker = path.join(fetchedRoot, ".complete");
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== upstream.commit) {
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
    const fetched = run("git", ["rev-parse", "FETCH_HEAD^{commit}"], staging).trim();
    if (fetched !== upstream.commit) {
      throw new Error(
        `Mastodon ${upstream.tag} is ${fetched}, but src/upstream.json records ${upstream.commit}`,
      );
    }
    run(
      "git",
      ["-c", "advice.detachedHead=false", "checkout", "--quiet", upstream.commit],
      staging,
    );
    for (const p of upstream.fetched) {
      if (!existsSync(path.join(staging, p))) {
        throw new Error(`Mastodon ${upstream.tag} has no ${p}`);
      }
    }
    rmSync(path.join(staging, ".git"), { recursive: true, force: true });
    writeFileSync(path.join(staging, ".complete"), `${upstream.commit}\n`);
    renameSync(staging, fetchedRoot);
  }
  // Fetched trees of other commits are not needed any more.
  for (const entry of readdirSync(cache)) {
    if (entry !== upstream.commit) {
      rmSync(path.join(cache, entry), { recursive: true, force: true });
    }
  }
  for (const p of upstream.served) {
    // `public/emoji` is upstream's `public/emoji`, served at `/emoji`.
    const link = path.join(workerRoot, p);
    const target = path.relative(path.dirname(link), path.join(fetchedRoot, p));
    const current = lstatSync(link, { throwIfNoEntry: false });
    if (current?.isSymbolicLink() && readlinkSync(link) === target) {
      continue;
    }
    rmSync(link, { recursive: true, force: true });
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  }
};

// ---------------------------------------------------------------------------
// Upstream's Vite config, ported

const cssAliasClasses: ReadonlyArray<string> = ["components", "features"];

/** Upstream's CSS module class names: `_<two path segments>_<file>__<class>`. */
const generateScopedName = (name: string, filename: string): string => {
  let prefix = "";
  const [parentDirName, dirName] = path
    .dirname(filename)
    .split(path.sep)
    .slice(-2)
    .map((dir) => dir.toLowerCase());
  if (parentDirName) {
    prefix = cssAliasClasses.includes(parentDirName) ? parentDirName.slice(0, 4) : parentDirName;
  }
  if (dirName) {
    prefix = `${prefix}_${dirName}`;
  }
  const baseName = path.basename(filename, `.module${path.extname(filename)}`);
  if (baseName !== "styles" && baseName !== "style") {
    prefix = `${prefix}_${baseName}`;
  }
  return `_${prefix}__${name}`;
};

/** Config the client build and the frontend tests share: aliases, CSS modules, PostCSS. */
export const webSharedConfig = (): UserConfig => ({
  resolve: {
    // `src/tsconfig.json`'s `paths` (`mastodon/*`, `images/*`, …).
    tsconfigPaths: true,
    alias: {
      "~/": `${webRoot}/`,
      "@/": `${webRoot}/`,
    },
  },
  css: {
    modules: { generateScopedName },
    postcss: {
      plugins: [postcssPresetEnv({ features: { "logical-properties-and-values": false } })],
    },
  },
  experimental: {
    // As upstream: asset URLs in JS resolve against `import.meta.url`, not `base`.
    renderBuiltUrl: () => undefined,
  },
  worker: { format: "es" },
});

/**
 * Runs `plugin`'s `configResolved` with `root` set to the frontend's
 * directory: upstream's plugins take Vite's root for `app/javascript`.
 */
const withWebRoot = (plugin: Plugin): Plugin => {
  const hook = plugin.configResolved;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (!handler) {
    return plugin;
  }
  return {
    ...plugin,
    configResolved(config) {
      const webConfig: ResolvedConfig = { ...config, root: webRoot };
      return handler.call(this, webConfig);
    },
  };
};

const isPlugin = (value: unknown): value is Plugin =>
  typeof value === "object" && value !== null && "name" in value && typeof value.name === "string";

/**
 * Plugin objects out of what plugin factories return (a plugin, an array, a
 * promise of either, or `false`). Some factories are typed against Rollup's
 * plugin type; at runtime they are Vite plugins.
 */
const flattenPlugins = async (options: ReadonlyArray<unknown>): Promise<Plugin[]> => {
  const plugins: Plugin[] = [];
  for (const option of options) {
    const value: unknown = await option;
    if (Array.isArray(value)) {
      plugins.push(...(await flattenPlugins(value)));
    } else if (isPlugin(value)) {
      plugins.push(value);
    }
  }
  return plugins;
};

/** Upstream's plugins that transform the frontend's modules (build and tests). */
export const webTransformPlugins = (): Promise<Plugin[]> =>
  flattenPlugins([
    react(),
    babel({ plugins: ["transform-react-remove-prop-types"] }),
    formatjs(),
    withWebRoot(MastodonServiceWorkerLocales()),
    svgr(),
    // Old library types need to be converted.
    optimizeLodashImports(),
  ]);

/** Keeps a plugin to the client environment: the Worker build never sees it. */
const clientOnly = (plugin: Plugin): Plugin => ({
  ...plugin,
  applyToEnvironment: (environment) => environment.name === "client",
});

/** Upstream's `findEntrypoints`: the service worker, `entrypoints/*`, `styles/entrypoints/*`. */
const findEntrypoints = (): Record<string, string> => {
  const entrypoints: Record<string, string> = {
    sw: path.join(webRoot, "mastodon/service_worker/sw.ts"),
  };
  const jsEntrypointsDir = path.join(webRoot, "entrypoints");
  for (const file of readdirSync(jsEntrypointsDir, { withFileTypes: true })) {
    if (file.isFile() && /\.[jt]sx?$/.test(file.name)) {
      entrypoints[file.name.replace(/\.[jt]sx?$/, "")] = path.join(jsEntrypointsDir, file.name);
    }
  }
  const scssEntrypointsDir = path.join(webRoot, "styles/entrypoints");
  for (const file of readdirSync(scssEntrypointsDir, { withFileTypes: true })) {
    if (file.isFile() && /\.s?css$/.test(file.name)) {
      entrypoints[file.name.replace(/\.s?css$/, "")] = path.join(scssEntrypointsDir, file.name);
    }
  }
  return entrypoints;
};

/** The `themes/<name>` entries upstream's themes plugin adds from `config/themes.yml`. */
const themeEntrypoints = async (
  entrypoints: Record<string, string>,
): Promise<Record<string, string>> => {
  const hook = MastodonThemes().config;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (!handler) {
    throw new Error("Mastodon's themes plugin has no config hook");
  }
  // The hook reads only its arguments, not its plugin context.
  const result: unknown = await Reflect.apply(handler, undefined, [
    { root: webRoot, envDir: workerRoot, build: { rolldownOptions: { input: entrypoints } } },
    { command: "build", mode: "production" },
  ]);
  return z
    .object({
      build: z.object({ rolldownOptions: z.object({ input: z.record(z.string(), z.string()) }) }),
    })
    .parse(result).build.rolldownOptions.input;
};

/** Upstream's chunk names, under `packs/` (upstream's output directory) of the client build. */
const chunkFileNames = ({ facadeModuleId, name }: Rolldown.PreRenderedChunk): string => {
  if (!facadeModuleId) {
    return "packs/[name]-[hash].js";
  }
  if (/mastodon\/locales\/[a-zA-Z-]+\.json/.test(facadeModuleId)) {
    // All locale files in `intl/`.
    return "packs/intl/[name]-[hash].js";
  }
  const formatjsPackage = /node_modules\/@formatjs\/([^/]+)\//.exec(facadeModuleId);
  if (formatjsPackage?.[1]) {
    return `packs/intl/[name]-${formatjsPackage[1]}-[hash].js`;
  }
  if (name === "index") {
    // Not too many chunks called "index".
    const parent = facadeModuleId.split("/").at(-2);
    if (parent) {
      return `packs/${parent}-[name]-[hash].js`;
    }
  }
  return "packs/[name]-[hash].js";
};

/**
 * The client environment: upstream's entry points and output names, under
 * `packs/` (`/packs/...`), except the service worker, which is `/sw.js` (its
 * scope is the whole origin; upstream links `public/sw.js` to `packs/sw.js`).
 */
const modernTargets = browserslist.loadConfig({ path: workerRoot });

export const webClientConfig = async (): Promise<UserConfig> => ({
  server: {
    // The dev service worker is a module URL; it needs the whole origin as scope.
    headers: { "Service-Worker-Allowed": "/" },
  },
  // Web Worker bundles (the emoji worker) name their assets as the client does.
  worker: {
    rolldownOptions: { output: { assetFileNames: "packs/assets/[name]-[hash][extname]" } },
  },
  environments: {
    client: {
      build: {
        // Upstream's output directory (`public/packs`), served at `/packs`.
        assetsDir: "packs",
        manifest: true,
        // Upstream builds source maps; the Worker's assets never shipped them.
        sourcemap: false,
        commonjsOptions: { transformMixedEsModules: true },
        chunkSizeWarningLimit: 1024 * 1024,
        assetsInlineLimit: (filePath: string) => (/\.woff2?$/.test(filePath) ? false : undefined),
        rolldownOptions: {
          input: await themeEntrypoints(findEntrypoints()),
          output: {
            chunkFileNames,
            entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "packs/[name]-[hash].js"),
            assetFileNames: "packs/assets/[name]-[hash][extname]",
          },
        },
      },
    },
  },
  plugins: (
    await flattenPlugins([
      webTransformPlugins(),
      withWebRoot(MastodonAssetsManifest()),
      MastodonServiceWorkerChunkPaths(),
      legacy({
        renderLegacyChunks: false,
        modernPolyfills: true,
        ...(modernTargets ? { modernTargets } : {}),
      }),
    ])
  ).map(clientOnly),
});

// ---------------------------------------------------------------------------
// The Worker's view of the client build

/**
 * Builds the client before the Worker, so the Worker build can read the
 * client's Vite manifest (`webManifest` below). Set as `builder.buildApp`:
 * the Cloudflare plugin keeps a user `buildApp`, and its own `buildApp` hook
 * then builds the Worker environments and writes `wrangler.json` with the
 * client output as the assets directory.
 */
export const buildClientFirst = async (builder: ViteBuilder): Promise<void> => {
  const client = builder.environments["client"];
  if (!client) {
    throw new Error('No "client" environment');
  }
  await builder.build(client);
};

const VIRTUAL_ID = "virtual:tstodon/web-manifest";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const ViteManifestSchema = z.record(
  z.string(),
  z.object({
    file: z.string(),
    css: z.array(z.string()).optional(),
    imports: z.array(z.string()).optional(),
  }),
);
type ViteManifest = z.infer<typeof ViteManifestSchema>;

/** The locales the frontend has messages for (`src/mastodon/locales/*.json`). */
const locales = (): string[] =>
  readdirSync(path.join(webRoot, "mastodon/locales"))
    .filter((file) => /^[a-zA-Z-]+\.json$/.test(file))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();

const defaultTheme = async (): Promise<string> => {
  const themes = await themeEntrypoints({});
  const file = themes["themes/default"];
  if (!file) {
    throw new Error("config/themes.yml has no default theme");
  }
  return file;
};

/** The manifest the Worker renders the shell from, for the client build in `clientOutDir`. */
const builtManifest = async (clientOutDir: string): Promise<unknown> => {
  const manifestFile = path.join(clientOutDir, ".vite", "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(
      `${path.relative(workerRoot, manifestFile)} is missing: the client must be built before the Worker`,
    );
  }
  const manifest: ViteManifest = ViteManifestSchema.parse(
    JSON.parse(readFileSync(manifestFile, "utf8")),
  );
  const url = (file: string) => `/${file}`;
  const key = (file: string) => path.relative(workerRoot, file).split(path.sep).join("/");
  const chunk = (name: string) => {
    const found = manifest[name];
    if (!found) {
      throw new Error(`Vite manifest has no entry ${name}`);
    }
    return found;
  };
  /** An entry's file, the CSS it and its static imports pull in, and the chunks to preload. */
  const entry = (name: string) => {
    const css = new Set<string>();
    const preload = new Set<string>();
    const seen = new Set<string>();
    const walk = (chunkKey: string, top: boolean) => {
      if (seen.has(chunkKey)) return;
      seen.add(chunkKey);
      const current = manifest[chunkKey];
      if (!current) return;
      for (const sheet of current.css ?? []) css.add(url(sheet));
      if (!top) preload.add(url(current.file));
      for (const imported of current.imports ?? []) walk(imported, false);
    };
    walk(name, true);
    return { js: url(chunk(name).file), css: [...css], preload: [...preload] };
  };
  const polyfills = Object.keys(manifest).find((name) => name.endsWith("vite/legacy-polyfills"));
  const favicon = Object.keys(manifest).find((name) => /^_favicon-32x32-.*\.png$/.test(name));
  if (!polyfills || !favicon) {
    throw new Error("Vite manifest has no legacy polyfills or 32x32 favicon");
  }
  return {
    ref: `${upstream.tag}+tstodon`,
    dev: false,
    polyfills: url(chunk(polyfills).file),
    themeSelection: url(chunk("src/entrypoints/theme-selection.ts").file),
    inert: url(chunk("src/styles/entrypoints/inert.scss").file),
    theme: url(chunk(key(await defaultTheme())).file),
    favicon: url(chunk(favicon).file),
    common: entry("src/entrypoints/common.ts"),
    application: entry("src/entrypoints/application.ts"),
    // The iframe page of the signed-out interaction modal (/remote_interaction_helper).
    remoteInteractionHelper: entry("src/entrypoints/remote_interaction_helper.ts"),
    locales: locales(),
  };
};

/** The manifest for Vite's dev server: source URLs, which Vite serves and hot-reloads. */
const devManifest = async (): Promise<unknown> => {
  const url = (file: string) => `/${path.relative(workerRoot, file).split(path.sep).join("/")}`;
  const entry = (name: string) => ({ js: url(path.join(webRoot, name)), css: [], preload: [] });
  return {
    ref: `${upstream.tag}+tstodon (dev)`,
    dev: true,
    devPreamble: react.preambleCode.replace("__BASE__", "/"),
    themeSelection: url(path.join(webRoot, "entrypoints/theme-selection.ts")),
    inert: url(path.join(webRoot, "styles/entrypoints/inert.scss")),
    theme: url(await defaultTheme()),
    favicon: url(path.join(webRoot, "icons/favicon-32x32.png")),
    common: entry("entrypoints/common.ts"),
    application: entry("entrypoints/application.ts"),
    remoteInteractionHelper: entry("entrypoints/remote_interaction_helper.ts"),
    locales: locales(),
  };
};

/**
 * `virtual:tstodon/web-manifest`: what the Worker renders the web app's
 * `<script>` / `<link>` tags from (`server/web-manifest.ts`). In a build it
 * is read from the client's Vite manifest, which `buildClientFirst` has
 * written; on the dev server it names the source files. `source: "build"`
 * reads the build output whatever the command (the Worker tests, which run
 * against `dist/`).
 */
export const webManifest = (options: Readonly<{ source?: "build" }> = {}): Plugin => {
  let clientOutDir = path.join(workerRoot, "dist/client");
  let dev = false;
  return {
    name: "tstodon:web-manifest",
    configResolved(config) {
      dev = config.command === "serve" && options.source !== "build";
      const outDir = config.environments["client"]?.build.outDir;
      if (outDir && options.source !== "build") {
        clientOutDir = path.resolve(config.root, outDir);
      }
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) {
        return null;
      }
      const manifest = dev ? await devManifest() : await builtManifest(clientOutDir);
      return `export default ${JSON.stringify(manifest)};\n`;
    },
  };
};

/** Fetches upstream's static trees before Vite looks at `public/` (dev and build). */
export const upstreamAssets = (): Plugin => ({
  name: "tstodon:upstream-assets",
  config() {
    ensureUpstreamAssets();
  },
});
