# Upstream: Mastodon web frontend

This directory is Mastodon's web frontend (upstream's `app/javascript`: the React app, its styles, images and fonts), vendored so tstodon can change it directly. It is the client of the Void app in `packages/worker` (Void's "SPA + API" shape: frontend in `src/`, server conventions in `app/`, shared server code in `server/`), built by the same `vite build` as the Worker. Mastodon is AGPL-3.0-or-later, as tstodon is; see `LICENSE` and `AUTHORS.md`.

| | |
| --- | --- |
| Repository | <https://github.com/mastodon/mastodon> |
| Tag | `v4.7.5` |
| Commit | `24cd1c875a1ac393e587421726394d5692ff5496` |

`upstream.json` holds the same values and the path mapping below; `packages/worker/web-build.ts` reads it. Keep the two in step.

## Path mapping

Upstream paths copied unmodified into this repository (`imported` in `upstream.json`), and where they live:

| Upstream | Here |
| --- | --- |
| `app/javascript/X` | `packages/worker/src/X` |
| `config/vite/` (Mastodon's Vite plugins) | `packages/worker/config/vite/` |
| `config/themes.yml` (read by the themes plugin) | `packages/worker/config/themes.yml` |
| `config/formatjs-formatter.js` (used by `i18n:extract`) | `packages/worker/config/formatjs-formatter.cjs` |
| `.browserslistrc` (the legacy plugin's modern targets) | `packages/worker/.browserslistrc` |
| `public/sounds/`, `public/badge.png`, `public/web-push-icon_{expand,favourite,reblog}.png` | `packages/worker/public/` (Vite's public directory, served at `/`) |
| `LICENSE`, `AUTHORS.md` | `packages/worker/src/` |

Upstream files tstodon ported instead of copying (`ported` in `upstream.json`); compare upstream's changes to them by hand:

| Upstream | Here |
| --- | --- |
| `vite.config.mts` | `packages/worker/web-build.ts` (client environment, shared config, plugins), composed with `voidPlugin()` in `packages/worker/vite.config.ts` |
| `vitest.config.mts` (`legacy-tests` project) | `packages/worker/vitest.config.ts` |
| `tsconfig.json` | `packages/worker/src/tsconfig.json` |
| `package.json` | the frontend's entries in `packages/worker/package.json` |

The import commit also carried upstream's `yarn.lock` and `.yarnrc.yml`; the pnpm integration removed them (the root `pnpm-lock.yaml` pins the frontend's dependencies, imported from that `yarn.lock` by `scripts/import-mastodon-web-lock.mjs`). Upstream's `.nvmrc`, `.oxfmtrc.json`, `eslint.config.mjs`, `stylelint.config.js`, `.storybook/`, `vitest.shims.d.ts` and the `public/sw.js` symlink were imported once and removed when the frontend moved into the Void app (see below).

Nothing from the Rails app, the streaming server or the rest of `public/` was imported.

## Fetched at build time

`public/emoji/` (twemoji SVGs, about 21 MB) and `public/ocr/` (Tesseract language data, about 11 MB) are not committed (`fetched` in `upstream.json`). The Void build (the `tstodon:upstream-assets` plugin's `config` hook, so `vp dev`, `vp build`, `void deploy` and CI all run it) and `packages/worker/vitest.config.ts` fetch them from the commit above into `.cache/mastodon-web/upstream/<commit>/`, checking that the tag still points at that commit, and link each `served` one into `packages/worker/public/` (gitignored there). The Worker serves `emoji/`; `ocr/` is fetched so the tree matches upstream but is not served (as before vendoring).

## Local changes

Changes against upstream, so a future merge knows what is ours:

- The frontend moved from upstream's `app/javascript/` to `packages/worker/src/`, so two `import.meta.glob` / dynamic import paths that climb to the repository's `node_modules` lost one `../`: `mastodon/polyfills/intl.ts` (`@formatjs/intl-pluralrules/locale-data`) and `mastodon/features/emoji/loader.ts` (`emojibase-data`). Without that the globs match nothing and the build silently drops the plural-rules locale data and the emoji picker's data. (`testing/api.ts` has the same pattern but is Storybook-only and already pointed above upstream's root.)
- `src/package.json` (`{ "private": true }`): the nearest `package.json` of the frontend has no `type`, as upstream's has none. Under `packages/worker`'s `"type": "module"`, Rolldown reads a default import of a CommonJS module with Node's semantics (`module.exports`, not its `__esModule` `default`), which breaks `import LoadingBar from 'react-redux-loading-bar'`; with `"type": "commonjs"` it wraps the side-effect-only `inline/theme-selection.js` as a CommonJS module, which the shell's classic `<script>` cannot load.
- `config/formatjs-formatter.js` is `config/formatjs-formatter.cjs` (CommonJS under `packages/worker`'s `"type": "module"`) and reads `../src/mastodon/locales/en.json`.
- `vite.config.mts` (ported to `web-build.ts`): the client is Vite's `client` environment of the Void app. Vite's root is `packages/worker`, not `app/javascript`, and `base` is `/`; the output keeps upstream's URLs by naming files under `packs/` (`build.assetsDir: "packs"`, chunk, entry and asset file names prefixed `packs/`, also for the emoji Web Worker's bundle), except the service worker, which is emitted as `/sw.js` (upstream links `public/sw.js` to `packs/sw.js`). Upstream's plugins run unmodified, scoped to the client environment; the ones that take Vite's root for `app/javascript` (`plugin-assets-manifest`, `plugin-sw-locales`) get `src/` as root, and the themes plugin's `config` hook is called directly for the `themes/*` entries. Dropped: source maps (the Worker's assets never shipped them), `rollup-plugin-gzip` (Workers compress responses), `vite-plugin-manifest-sri` (the Worker renders no `integrity`), `rollup-plugin-visualizer`, the dev server's port and proxy settings (Void's dev server serves everything) and the themes plugin's `/packs-dev/themes/` dev rewrite (the dev shell links the theme's source). The Vite and Vitest are the workspace's (Vite+ core 1.3.0, i.e. Vite 8.3; Vitest 5), not upstream's 8.2 / 4.1.
- `vitest.config.mts` (ported to `packages/worker/vitest.config.ts`): only upstream's `legacy-tests` project (jsdom), as the `web` project, run from `packages/worker` (`pnpm test:web`); the Storybook project is gone.
- `tsconfig.json` (ported to `src/tsconfig.json`): `paths` relative to `src/`, no `incremental` cache, and the Storybook files (`*.stories.*`, `testing/api.ts`, `mastodon/components/status/testing.ts`) excluded. The typecheck runs on the workspace's TypeScript 7 (`pnpm typecheck:web`), not upstream's TypeScript 6.
- Storybook, ESLint, Stylelint and oxfmt are not set up: their configs and packages were removed (the story files stay, unbuilt and unchecked, so merges stay mechanical). Root `vp check` skips `src/` and `config/` (upstream's formatting and lint).
- `package.json` (merged into `packages/worker/package.json`): upstream's dependency versions. Removed with the tooling above: `@csstools/stylelint-formatter-github`, `cross-env`, `rollup-plugin-gzip`, `rollup-plugin-visualizer`, `vite-plugin-manifest-sri`, ESLint and its plugins, `typescript-eslint`, `globals`, Stylelint and its config, `oxfmt`, Storybook and its addons, `chromatic`, `msw`, `msw-storybook-addon`, `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8`, `@vitest/ui`, `playwright`, `typescript` (TS 6) and `@typescript/native`; `vite` and `vitest` come from the workspace catalog. Upstream relies on Yarn hoisting for a few packages it does not declare; pnpm does not hoist, so they are declared at the versions upstream's `yarn.lock` resolved: `browserslist` (read by the build), `tesseract.js-core` (imported by the alt text modal), and for the typecheck and tests `@types/history`, `jsdom` and `redux` (`HOISTED` in `scripts/import-mastodon-web-lock.mjs`). Scripts: only `i18n:extract` is kept.
- `UPSTREAM.md`, `upstream.json`, `package.json` added here.
- Repository root: `pnpm-workspace.yaml` lists the install scripts the frontend's dependencies may not run; `vite.config.ts` keeps `vp check` out of `src/` and `config/`.

### REST types from `@tstodon/api`

<!-- constrained-by ../../api/README.md -->

The REST JSON shapes the client reads are defined once, in `packages/api` (`@tstodon/api`), and the server's document builders return the same types.

- `mastodon/api_types/*.ts` keep their paths and exported names but re-export the entity types from `@tstodon/api` (`export type { ApiStatusJSON, ... } from '@tstodon/api'`, erased at build time). What stays local: client-only shapes and helpers (`ApiStatusTranslationJSON`, the client's translation with `contentHtml` / `spoilerHtml`; the collection envelopes and payloads; `ApiProfileUpdateParams`; `ValidationErrorResponse`; `allNotificationTypes`, the types this UI requests), and `isStatusVisibility` / `isQuotePolicy`, now built on `@tstodon/api/values` (Zod-free constants: importing it adds no Zod to the bundle), as is `reducers/compose.js`'s visibility order (`STATUS_VISIBILITIES`). `notifications.ts` aliases `NotificationType`, `ApiNotificationJSON` and `ApiNotificationGroupJSON` to Mastodon's types only (`MastodonNotificationType`, `ApiMastodonNotification*`): tstodon's `move` notification is not one this UI renders.
- The shared types follow Mastodon's wire format, which is stricter than upstream's hand-written interfaces in places (nullable fields upstream typed optional or non-null). The code that read them was adjusted, each change type-level or a null fallback with the behaviour upstream had for a missing value: `models/status.ts` (`StatusShape`: `edited_at`, `language`, `in_reply_to_id`, `in_reply_to_account_id`, `card` and `application.website` may be `null`), `actions/importer/statuses.ts` (no dead `content` / `quote_approval` defaults under the spread; a `null` attachment description searches as empty), `components/status/attachments.tsx` (a `null` description, preview or blurhash, and `meta.original` / `meta.colors` an attachment may lack: no aspect ratio, no colours), `components/status/content.tsx`, `components/status/status.tsx` (a `null` language or reply id passed on as `undefined`), `components/blurhash.tsx` (`hash` may be `null`; it already drew nothing then), `components/poll.tsx` (an option's `votes_count` is `null` while a poll hides its totals: counted as 0), `reducers/contexts.ts`, `actions/compose_typed.ts` (no redirect to a `null` URL), `features/notifications_v2/components/notification_group_with_status.tsx` (`timestamp` optional: a group fetched on its own has no `latest_page_notification_at`, which it already handled), `models/notification_group.ts` (an `annual_report` notification keeps its report, as its group does) and `testing/factories.ts` (the fixtures fill the required fields).
- On a merge, upstream's changes to `app/javascript/mastodon/api_types/*.ts` are not taken as they are: apply each new or changed field to the matching schema in `packages/api/src/*.ts` (Mastodon's serializers are the reference), keep the files here as re-exports, and let `pnpm typecheck:web` and the Worker's typecheck show the client and server code that must follow. A new upstream-only helper stays in the `api_types` file.

### Branding

The UI is branded tstodon, with a credit to Mastodon. Only user-visible text and images changed: the `mastodon/` directory, import paths, CSS classes, storage and Redux keys and message ids are upstream's, so merges stay mechanical.

- Strings: `locales/en.json` and the English `defaultMessage`s name the product "tstodon" where upstream said "Mastodon", and say "the fediverse" where it meant the network (`sign_in_banner.mastodon_is`, `closed_registrations_modal.*`, `server_banner.is_one_of_many`, the annual report texts, …). Every other locale had "Mastodon" and its transliterations (마스토돈, מסטודון, ماستودون, मास्टोडन, …) renamed to "tstodon" mechanically, so a sentence about the network reads "tstodon" there. `about.disclaimer`, `annual_report.shared_page.footer` and `confirmations.hide_featured_tab.message` changed meaning, so their translations were removed and those messages fall back to English. `footer.based_on` ("Based on {name}") is new. On a merge, take upstream's new translations and rename "Mastodon" in them the same way; keep the English values.
- Credit and links: the link footer's second section is "tstodon:" (About links `https://github.com/<meta.repository>`, "Based on Mastodon" links Mastodon's repository, "View source code" stays `meta.source_url`); the about page's "powered by" links tstodon and its disclaimer credits Mastodon; the error boundary shows "tstodon v…". The annual report's shared page links tstodon and has no "Donate" link (it was Mastodon's). Constants live in `src/mastodon/tstodon/brand.ts`.
- Logo: `components/logo.tsx` keeps upstream's component names (`WordmarkLogo`, `IconLogo`, `SymbolLogo`) but draws the tstodon mark inline (`brand.ts` `symbolPath`: a speech bubble with "ts" cut out). `images/tstodon-symbol.svg` (brand colour, transparent) and `images/tstodon-app-icon.svg` (white mark on a full-bleed square of the brand colour) hold the same path. The brand colour is the theme's accent, `#5e6ad2` (`indigo-600`, `--color-bg-brand-base`), also the fallback fill of `SymbolLogo`.
- Icons: `icons/favicon-*.png` were rendered from `tstodon-symbol.svg`, `icons/android-chrome-*.png` and `icons/apple-touch-icon-*.png` from `tstodon-app-icon.svg`, and `public/badge.png` (now `packages/worker/public/badge.png`) from the mark in black on transparent (an alpha mask, so it has no colour), each at upstream's file names and sizes. `public/android-chrome-192x192.png` (not in upstream's tree) is the 192px app icon again at the fixed URL the service worker gives grouped notifications (`icon: '/android-chrome-192x192.png'` in `service_worker/web_push_notifications.js`); the hashed `icons/` copies are not at that URL. Re-render them all after changing the mark or the brand colour: with sharp (in the workspace's pnpm store), `sharp(svg, { density }).resize(size, size).png({ compressionLevel: 9 })`, where `density` is `ceil(72 * size / viewBox) * 2` (viewBox 64 for the symbol, 512 for the app icon), so no size is upscaled. Last rendered at `#5e6ad2`.
- Removed: Mastodon's logos (`images/logo.svg`, `images/logo-symbol-icon.svg`, `images/logo-symbol-wordmark.svg`, `images/app-icon.svg`, `images/mailer/{logo,wordmark}.png`, `images/mailer-new/common/logo-{header,footer}.png`, the app screenshots `images/mailer-new/welcome/feature_*.png`) and the mascot (`images/elephant_ui*.svg`, `images/friends-cropped.png`, `images/preview.png`, `images/archetypes/{booster,lurker,oracle,pollster,replier}.png` and `images/archetypes/previews/`, `public/loading.{gif,png}`, `public/oops.{gif,png}`). A merge that touches one of these comes back as a modify/delete conflict; keep the deletion. (Storybook's `.storybook/main.ts` mapped the new symbol where it mapped `logo.svg`, until Storybook was removed.)
- Where the mascot was: `components/empty_state` shows no image by default and an `error` icon for errors; `components/regeneration_indicator` an `hourglass` icon; `features/ui/components/modal_placeholder` an `error` icon; the annual report archetypes a Material Symbols icon each; the compose drawer and announcements show `meta.mascot` only when the server sets one. `entrypoints/error.ts` (Rails' error page) is empty. `images/anniversary.svg` (a laurel wreath, no Mastodon branding) stays.

### Theme

tstodon replaces Mastodon's look with a flat, Linear-like design in two colour schemes. The scheme still follows `data-color-scheme` (`auto` resolves to the OS setting through `inline/theme-selection.js`, unchanged) and `data-contrast` (`high`, or the OS `prefers-contrast: more`, applies each scheme's `contrast-overrides`). Class names and the token names components use are upstream's; the changes are in values, so on a merge take upstream's structure and re-apply these values:

- `src/styles/mastodon/tokens/theme/_base.scss`: the palette. Neutral greys (`grey-50` `#f7f8f8` … `grey-950` `#08090a`, with `grey-450`, `grey-850` and `grey-925` added), an indigo accent scale (`indigo-600` `#5e6ad2`), and desaturated red, amber and green scales. Step names are upstream's.
- `tokens/theme/_dark.scss`, `tokens/theme/_light.scss`: the token mappings and both `contrast-overrides`. New token `--color-bg-app` (the page behind the columns; `basics.scss` paints `html` and `body` with it). Status links use the accent (`--color-text-status-links: var(--color-text-brand)`), the brand hover is darker so white text stays at AA, `--dropdown-shadow` is one short soft shadow, and the rich-text (code, quote) tokens are neutral.
- `tokens/_shape.scss`: radii 4 / 6 / 8 / 10 / 12px (`--radius-xs` … `--radius-xl`).
- `styles/fonts/inter.scss`: upright Inter is the bundled variable font (`fonts/inter/inter-variable-font-slnt-wght.woff2`, OFL, already in upstream's tree) with its weight range clamped to 400–600, replacing the static regular and semibold upright faces; the italic faces are upstream's.
- `styles/mastodon/basics.scss`: `--font-body` is Inter with a system fallback stack and `--font-heading` follows it (upstream: Roboto and Syne); `html` / `body` background is `--color-bg-app`.
- `styles/mastodon/components.scss` (each block marked `tstodon theme`): `.button` (14px, 6px radius), neutral `.button.button-secondary` and `.dropdown-button`, compact `.column-link` with a solid selected row and accent icon, a hover background on timeline rows (`.status__wrapper`, `.notification-group`, `.conversation`), `.dropdown-menu` radius and neutral item hover, no glow under an active `.column-header__wrapper` or its icon, tabular numbers in `.animated-number` and `.character-counter`.

Outside this package, `packages/worker/src/web-app.ts` sets the `theme-color` meta values to the app backgrounds (`#08090a` dark, `#f7f8f8` light).

## Working on it

Change the frontend here and list each change against upstream under "Local changes" above. `pnpm dev` serves it from source with hot reload (the Worker's shell links the source entry points, Vite's HMR client and the React Refresh preamble); `pnpm build` builds it into `packages/worker/dist/client/` with the Worker. Its checks: `pnpm typecheck:web` and `pnpm test:web` (CI runs both). The Worker renders the shell from `virtual:tstodon/web-manifest` (`web-build.ts`), which names the entries `src/entrypoints/{common,application,remote_interaction_helper,theme-selection}.ts`, `src/styles/entrypoints/inert.scss` and the default theme.

How to move to a newer upstream release, including `scripts/import-mastodon-web-lock.mjs`, which locks the dependencies at the versions upstream's `yarn.lock` resolved: [docs/operations/mastodon-web-upstream.md](../../../docs/operations/mastodon-web-upstream.md).
