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
- `package.json`
- `public/sounds/`, `public/sw.js` (a symlink to the built `packs/sw.js`), `public/badge.png`, `public/loading.{gif,png}`, `public/oops.{gif,png}`, `public/web-push-icon_{expand,favourite,reblog}.png`
- `LICENSE`, `AUTHORS.md`

This commit also carries upstream's `yarn.lock` and `.yarnrc.yml` for reference; the pnpm integration replaces them.

Nothing from the Rails app, the streaming server or the rest of `public/` was imported.

## Fetched at build time

`public/emoji/` (twemoji SVGs, about 21 MB) and `public/ocr/` (Tesseract language data, about 11 MB) are not committed. `pnpm web:build` fetches them from the commit above into `.cache/mastodon-web/upstream/<commit>/` and links them into `packages/web/public/` (gitignored). The Worker serves `emoji/`; `ocr/` is fetched so the tree matches upstream but is not copied into the Worker's assets (as before vendoring).

How to move to a newer upstream release: [docs/operations/mastodon-web-upstream.md](../../docs/operations/mastodon-web-upstream.md).
