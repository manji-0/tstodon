# Upstream: Mastodon web frontend

This package is Mastodon's web frontend (the React app under `app/javascript`, its Vite build and the static files the Worker serves beside it), vendored so tstodon can change it directly. Mastodon is AGPL-3.0-or-later, as tstodon is; see `LICENSE` and `AUTHORS.md`.

| | |
| --- | --- |
| Repository | <https://github.com/mastodon/mastodon> |
| Tag | `v4.7.5` |
| Commit | `24cd1c875a1ac393e587421726394d5692ff5496` |

`upstream.json` holds the same values; `scripts/build-mastodon-web.mjs` reads it. Keep the two in step.

## Imported paths

These upstream paths were copied unmodified into `packages/web/` (the `imported` list in `upstream.json`):

- `app/javascript/` (the frontend)
- `config/vite/` (Mastodon's Vite plugins), `config/themes.yml` (read by the themes plugin), `config/formatjs-formatter.js` (used by `i18n:extract`)
- `vite.config.mts`, `tsconfig.json`, `.browserslistrc`, `.nvmrc`
- `vitest.config.mts`, `vitest.shims.d.ts`, `.storybook/` (Mastodon's tests and stories; not used by the build)
- `eslint.config.mjs`, `stylelint.config.js`, `.oxfmtrc.json` (Mastodon's lint and format settings; tstodon's own `vp check` skips this package)
- `package.json` (adapted to pnpm, see below)
- `public/sounds/`, `public/sw.js` (a symlink to the built `packs/sw.js`), `public/badge.png`, `public/loading.{gif,png}`, `public/oops.{gif,png}`, `public/web-push-icon_{expand,favourite,reblog}.png`
- `LICENSE`, `AUTHORS.md`

The import commit also carried upstream's `yarn.lock` and `.yarnrc.yml`; the pnpm integration commit removed them (the root `pnpm-lock.yaml` now pins this package's dependencies, imported from that `yarn.lock`).

Nothing from the Rails app, the streaming server or the rest of `public/` was imported.

## Fetched at build time

`public/emoji/` (twemoji SVGs, about 21 MB) and `public/ocr/` (Tesseract language data, about 11 MB) are not committed. `pnpm web:build` fetches them from the commit above into `.cache/mastodon-web/upstream/<commit>/` and links them into `packages/web/public/` (gitignored). The Worker serves `emoji/`; `ocr/` is fetched so the tree matches upstream but is not copied into the Worker's assets (as before vendoring).

## Local changes

Changes against upstream, so a future merge knows what is ours:

- `package.json`: renamed `@tstodon/web`; Yarn-only fields removed (`packageManager`, `workspaces`), and with them the scripts and packages that only make sense in Mastodon's own repository (`postinstall` / `husky`, `lint-staged`, `postversion`, `start` for the streaming server); scripts call `pnpm` where they called `yarn`. Upstream relies on Yarn hoisting for a few packages it does not declare; pnpm does not hoist, so they are declared at the versions upstream's `yarn.lock` resolved: `browserslist` (read by `vite.config.mts`), `tesseract.js-core` (imported by the alt text modal), and for the typecheck and tests `@types/history`, `jsdom` and `redux`. Every other dependency version is upstream's.
- `vitest.config.mts`: Storybook's test integration starts `pnpm run storybook`.
- `.gitignore`, `UPSTREAM.md`, `upstream.json` added.
- Repository root: `pnpm-workspace.yaml` keeps upstream's `vite` and `vitest` for this package (the rest of the workspace gets Vite+) and lists the install scripts this package's dependencies may not run; `vite.config.ts` keeps `vp check` out of this package.

How to move to a newer upstream release: [docs/operations/mastodon-web-upstream.md](../../docs/operations/mastodon-web-upstream.md).
