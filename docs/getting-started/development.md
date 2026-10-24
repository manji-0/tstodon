# Development Workflow

## Commands

```sh
pnpm types:worker
pnpm check
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt
pnpm fmt:check
pnpm dev
pnpm build
pnpm web:build
pnpm e2e:web
pnpm run ci
```

`pnpm run ci` is the merge gate (`pnpm ci` is pnpm's frozen install). The toolchain is [Vite+](https://viteplus.dev/) (`vp`). The root `vite.config.ts` holds the lint, format, and test settings; `packages/worker` is the Void app, with its own `vite.config.ts`, `void.json`, and `wrangler.jsonc`:

- `pnpm check` (`vp check`) formats with Oxfmt, lints with Oxlint (type-aware rules via oxlint-tsgolint), and type-checks every package including tests. `pnpm typecheck` runs only the type check. Each package `tsconfig.json` is a standalone `noEmit` project; nothing is emitted by TypeScript.
- `pnpm test` (`vp -C packages/worker build && vp test run`) runs Vitest 5. Worker tests run in workerd through `@cloudflare/vitest-plugin`, against the Void build in `packages/worker/dist/`.
- `pnpm dev` and `pnpm build` (`vp -C packages/worker dev|build`) run the Worker through [Void](https://void.cloud) (`voidPlugin()`), which wraps `@cloudflare/vite-plugin` (Vite + Rolldown) and generates the Worker entry in `packages/worker/.void/` (gitignored). Bindings, vars, and resource IDs still come from `packages/worker/wrangler.jsonc`; Void adds `main`, cron `triggers`, and the queue consumer from `packages/worker/app`. Static assets come from `packages/worker/assets/` (Vite's `publicDir`).
- `pnpm web:build` builds Mastodon's web UI from a pinned release into `packages/worker/assets/` (see [Web UI](../reference/configuration.md#web-ui)); without it the web app's paths serve the static placeholder page.
- `pnpm e2e:web` runs the Playwright scenarios against Mastodon's web UI on a fresh local instance (see [Browser e2e](e2e-web.md)).
- `pnpm run deploy` builds the web UI, then runs `void deploy --backend cloudflare` in `packages/worker` (see [Cloudflare deploy](../operations/cloudflare-deploy.md)); plain `pnpm deploy` is pnpm's own command.
- Local state (D1, KV, R2, Durable Objects, Workflows) lives in `packages/worker/.wrangler/state`, wrangler's default for `packages/worker/wrangler.jsonc`. Apply D1 migrations to it with `pnpm db:migrate:local`. Void's own dev-time migration runner is disabled in `packages/worker/vite.config.ts`: it migrates a separate `.void/` database, not the `DB` binding.

TypeScript targets ES2025 with `erasableSyntaxOnly` and `verbatimModuleSyntax`.

## HTTP routing

<!-- derived-from ../architecture/tstodon-architecture.md#http-routing -->

Void serves HTTP from file routes in `packages/worker/app/routes/` (`void.json` sets `sourceDir` to `packages/worker/app`). To add an endpoint:

1. Write the handler in a module under `packages/worker/src/routes/` as an exported Hono handler, typed with its path so `c.req.param()` stays exact:

   ```ts
   export const getV1StatusesByIdContext = async (
     c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/context">,
   ) => { ... };
   ```

2. Re-export it from the route file for that path, named after the HTTP method. `[id]` is a path parameter; a path that also has children uses `index.ts`:

   ```ts
   // packages/worker/app/routes/api/v1/statuses/[id]/context.ts
   export { getV1StatusesByIdContext as GET } from "#src/routes/statuses/read";
   ```

`#src/*` is a package import of `@tstodon/worker` (`packages/worker/src/*`). Handlers are plain Hono handlers rather than `defineHandler` callbacks because Void types `c.env` with its own bindings, not the `Env` from `wrangler types`; at runtime `defineHandler(fn)` is `fn`. Void orders static segments before parameters (`accounts/lookup` wins over `accounts/[id]`) and the catch-all last.

- `app/middleware/01.cors.ts`: CORS for `/api/*` and the media paths.
- `app/middleware/02.well-known.ts`: `/.well-known/webfinger` and `/.well-known/nodeinfo`. Void's route scanner skips dot directories, so these cannot be route files.
- `app/routes/[...].ts`: requests no route matched. GET and HEAD fall back to static assets; other methods get `{ "kind": "NotFound" }`.

Queue consumers, cron, Workflows, and Durable Objects are not HTTP routes:

- Cron jobs: `packages/worker/app/crons/*.ts` export `cron` (one expression or an array) and a `defineScheduled` default.
- Queue consumers: `packages/worker/app/queues/<queue-name>.ts` export a `defineQueue` default plus `maxBatchSize` / `maxBatchTimeout` / `maxRetries`. The file name is the Cloudflare queue name. Void has no `max_concurrency` option, so the queue file also exports `maxConcurrency`, and the `tstodon:queue-consumer-concurrency` plugin (`packages/worker/void-plugins.ts`) writes it onto the consumer in the built `wrangler.json`.
- Workflow and Durable Object classes: export them from `packages/worker/src/entry-classes.ts`. Void's generated entry only exports Void's own classes, so the `tstodon:export-entry-classes` plugin (`packages/worker/void-plugins.ts`) appends this module to it.

`packages/worker/wrangler.jsonc` `main` points at `src/entry-classes.ts` only so `wrangler types` can type the class bindings; Void replaces it in dev and build. Worker tests run in workerd against the build output (`packages/worker/dist/ssr/wrangler.json`), so they exercise Void's routing; `pnpm test` builds first.

### Triggering cron locally

Void's `/__void/scheduled` dev trigger is shadowed by the catch-all route, so fire cron through the Cloudflare local explorer instead:

```sh
curl -X POST 'http://127.0.0.1:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=tstodon' \
  -H 'content-type: application/json' -d '{"cron":"17 * * * *"}'
```

Queue messages are delivered to the consumer by Miniflare as in production.

## Domain changes

Put new state in `packages/domain` as a `z.discriminatedUnion("kind", ...)` plus a companion object. One concept per file. Tests live next to the module.

## Generated types

Re-run `pnpm types:worker` after changing bindings in `packages/worker/wrangler.jsonc`. It writes `packages/worker/worker-configuration.d.ts`.

After editing `prisma/sql/*.sql` or applying D1 migrations, regenerate TypedSQL:

```sh
pnpm db:migrate:local
pnpm prisma:generate
```

See [Prisma TypedSQL conventions](../architecture/prisma-typedsql.md).
