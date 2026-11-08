// Mastodon's frontend tests (upstream's `legacy-tests` Vitest project) on the
// workspace's Vitest, in jsdom. Run from this directory (`pnpm test:web`):
// some tests read upstream's fetched trees under `public/` relative to the
// working directory, as upstream's run from its repository root does. The
// Worker's tests are the root `vite.config.ts`'s projects.
import { configDefaults, defineConfig, mergeConfig } from "vite-plus";
import { ensureUpstreamAssets, webSharedConfig, webTransformPlugins } from "./web-build";

ensureUpstreamAssets();

export default mergeConfig(
  webSharedConfig(),
  defineConfig({
    plugins: await webTransformPlugins(),
    test: {
      name: "web",
      root: import.meta.dirname,
      environment: "jsdom",
      include: [
        "src/**/*.{test,spec}.?(c|m)[jt]s?(x)",
        "src/**/__tests__/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      ],
      exclude: [...configDefaults.exclude, "**/node_modules/**"],
      globals: true,
      setupFiles: ["fake-indexeddb/auto"],
    },
  }),
);
