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
- `public/sounds/`, `public/sw.js` (a symlink to the built `packs/sw.js`), `public/badge.png`, `public/web-push-icon_{expand,favourite,reblog}.png` (`public/loading.{gif,png}` and `public/oops.{gif,png}` were imported too, then removed with the mascot; see "Branding" below)
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

### Branding

The UI is branded tstodon, with a credit to Mastodon. Only user-visible text and images changed: the `mastodon/` directory, import paths, CSS classes, storage and Redux keys and message ids are upstream's, so merges stay mechanical.

- Strings: `locales/en.json` and the English `defaultMessage`s name the product "tstodon" where upstream said "Mastodon", and say "the fediverse" where it meant the network (`sign_in_banner.mastodon_is`, `closed_registrations_modal.*`, `server_banner.is_one_of_many`, the annual report texts, …). Every other locale had "Mastodon" and its transliterations (마스토돈, מסטודון, ماستودون, मास्टोडन, …) renamed to "tstodon" mechanically, so a sentence about the network reads "tstodon" there. `about.disclaimer`, `annual_report.shared_page.footer` and `confirmations.hide_featured_tab.message` changed meaning, so their translations were removed and those messages fall back to English. `footer.based_on` ("Based on {name}") is new. On a merge, take upstream's new translations and rename "Mastodon" in them the same way; keep the English values.
- Credit and links: the link footer's second section is "tstodon:" (About links `https://github.com/<meta.repository>`, "Based on Mastodon" links Mastodon's repository, "View source code" stays `meta.source_url`); the about page's "powered by" links tstodon and its disclaimer credits Mastodon; the error boundary shows "tstodon v…". The annual report's shared page links tstodon and has no "Donate" link (it was Mastodon's). Constants live in `app/javascript/mastodon/tstodon/brand.ts`.
- Logo: `components/logo.tsx` keeps upstream's component names (`WordmarkLogo`, `IconLogo`, `SymbolLogo`) but draws the tstodon mark inline (`brand.ts` `symbolPath`: a speech bubble with "ts" cut out). `images/tstodon-symbol.svg` (brand colour, transparent) and `images/tstodon-app-icon.svg` (white mark on a full-bleed square) hold the same path.
- Icons: `icons/favicon-*.png` were rendered from `tstodon-symbol.svg`, `icons/android-chrome-*.png` and `icons/apple-touch-icon-*.png` from `tstodon-app-icon.svg`, and `public/badge.png` from the mark in black on transparent (an alpha mask), each at upstream's file names and sizes (sharp, `density` high enough that no size is upscaled). Re-render them after changing the mark.
- Removed: Mastodon's logos (`images/logo.svg`, `images/logo-symbol-icon.svg`, `images/logo-symbol-wordmark.svg`, `images/app-icon.svg`, `images/mailer/{logo,wordmark}.png`, `images/mailer-new/common/logo-{header,footer}.png`, the app screenshots `images/mailer-new/welcome/feature_*.png`) and the mascot (`images/elephant_ui*.svg`, `images/friends-cropped.png`, `images/preview.png`, `images/archetypes/{booster,lurker,oracle,pollster,replier}.png` and `images/archetypes/previews/`, `public/loading.{gif,png}`, `public/oops.{gif,png}`). A merge that touches one of these comes back as a modify/delete conflict; keep the deletion. `scripts/build-mastodon-web.mjs` no longer copies `loading.*` / `oops.*`, and `.storybook/main.ts` maps the new symbol where it mapped `logo.svg`.
- Where the mascot was: `components/empty_state` shows no image by default and an `error` icon for errors; `components/regeneration_indicator` an `hourglass` icon; `features/ui/components/modal_placeholder` an `error` icon; the annual report archetypes a Material Symbols icon each; the compose drawer and announcements show `meta.mascot` only when the server sets one. `entrypoints/error.ts` (Rails' error page) is empty. `images/anniversary.svg` (a laurel wreath, no Mastodon branding) stays.

## Working on it

Change the frontend here and list each change against upstream under "Local changes" above. `pnpm web:build` builds it into the Worker's assets (see `scripts/build-mastodon-web.mjs`). Mastodon's own checks run as in upstream, through pnpm: `pnpm -C packages/web typecheck` and `pnpm -C packages/web test:js run` (CI runs both). The `lint`, `format` and Storybook scripts are kept from upstream but not run or checked here.

How to move to a newer upstream release, including `scripts/import-mastodon-web-lock.mjs`, which locks the dependencies at the versions upstream's `yarn.lock` resolved: [docs/operations/mastodon-web-upstream.md](../../docs/operations/mastodon-web-upstream.md).
