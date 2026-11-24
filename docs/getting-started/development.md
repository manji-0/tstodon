# Development Workflow

## Commands

<!-- constrained-by ../reference/configuration.md#web-ui -->

```sh
pnpm types:worker
pnpm check
pnpm typecheck
pnpm test
pnpm typecheck:web
pnpm test:web
pnpm lint
pnpm fmt
pnpm fmt:check
pnpm dev
pnpm build
pnpm e2e:web
pnpm run ci
```

`pnpm run ci` is the merge gate (`pnpm ci` is pnpm's frozen install). The toolchain is [Vite+](https://viteplus.dev/) (`vp`). The root `vite.config.ts` holds the lint, format, and test settings; `packages/worker` is the Void app, with its own `vite.config.ts` and `void.config.ts` (Void's settings and, under `cloudflare`, the Worker's Cloudflare config: bindings, vars, resource IDs). It has Void's "SPA + API" shape: Void's conventions in `app/`, the Worker's shared code in `server/` (`#server/*`), the client, Mastodon's web frontend, in `src/`, and committed static files in `public/`:

- `pnpm check` (`vp check`) formats with Oxfmt, lints with Oxlint (type-aware rules via oxlint-tsgolint), and type-checks every package including tests. `pnpm typecheck` runs only the type check. Each package `tsconfig.json` is a standalone `noEmit` project; nothing is emitted by TypeScript.
- `pnpm test` (`vp -C packages/worker build && vp test run`) runs Vitest 5. Worker tests run in workerd through `@cloudflare/vitest-plugin`, against the Void build in `packages/worker/dist/`.
- `pnpm dev` and `pnpm build` (`vp -C packages/worker dev|build`) run the Worker through [Void](https://void.cloud) (`voidPlugin()`), which wraps `@cloudflare/vite-plugin` (Vite + Rolldown) and generates the Worker entry in `packages/worker/.void/` (gitignored). Bindings, vars, and resource IDs come from `cloudflare` in `packages/worker/void.config.ts`; Void adds `main`, cron `triggers`, and the queue consumers from `packages/worker/app`, and writes the result to `packages/worker/.void-wrangler.jsonc` (gitignored). The build writes the Worker to `packages/worker/dist/ssr/` (with a `wrangler.json`) and the Cloudflare Build Output that `void deploy` uploads to `packages/worker/.cloudflare/output/`. The same build builds the client first, Mastodon's web UI from `packages/worker/src` (see [Web UI](../reference/configuration.md#web-ui)), into `packages/worker/dist/client/` with `packages/worker/public/`; that directory is the Worker's static assets. `pnpm dev` serves the frontend from source with hot reload. The first build or dev start fetches upstream's emoji (needs `git` and network access to GitHub).
- `packages/worker/src` is Mastodon's frontend, vendored (see `packages/worker/src/UPSTREAM.md` and [Mastodon web upstream](../operations/mastodon-web-upstream.md)). It keeps Mastodon's code style, so `pnpm check` skips `src/` and `config/` (upstream's Vite plugins). Its own checks are `pnpm typecheck:web` (TypeScript with `packages/worker/src/tsconfig.json`) and `pnpm test:web` (Mastodon's Vitest suite in jsdom, `packages/worker/vitest.config.ts`; the emoji test reads `public/emoji`, which the config fetches when missing). `pnpm run ci` runs both.
- `pnpm e2e:web` runs the Playwright scenarios against Mastodon's web UI on a fresh local instance (see [Browser e2e](e2e-web.md)).
- `pnpm run deploy` runs `void deploy --platform cloudflare` in `packages/worker`, which builds the Worker and the web UI (see [Cloudflare deploy](../operations/cloudflare-deploy.md)); plain `pnpm deploy` is pnpm's own command.
- `pnpm wrangler:worker <args>` runs Wrangler in `packages/worker` against the Worker's config (`scripts/wrangler.mjs` writes `cloudflare` from `void.config.ts` to `.void-wrangler.jsonc` and passes `--config`), for example `pnpm wrangler:worker d1 execute tstodon --local --command "SELECT 1"`. There is no `wrangler.jsonc` for a bare `wrangler` to find.
- Local state (D1, R2, Durable Objects, Workflows) lives in `packages/worker/.wrangler/state`. Apply D1 migrations to it with `pnpm db:migrate:local`. Void's own dev-time migration runner is disabled in `packages/worker/vite.config.ts`: it records migrations in its own `_void_migrations` table, beside Wrangler's `d1_migrations`.
- Local values: `packages/worker/.env` (gitignored, the only dotenv file Void reads; it refuses to start next to a `.dev.vars*`, `.env.*` or `.env.example` file). It holds the secrets `packages/worker/app/env.ts` declares and overrides vars from `void.config.ts` under `pnpm dev`, for example `CF_ACCESS_TEAM_DOMAIN=...` or `VAPID_PRIVATE_JWK=...`. `pnpm dev` needs none of it: Void supplies a development `BETTER_AUTH_SECRET`. Builds and deploys never read it.

TypeScript targets ES2025 with `erasableSyntaxOnly` and `verbatimModuleSyntax`.

## HTTP routing

<!-- derived-from ../architecture/tstodon-architecture.md#http-routing -->

Void serves HTTP from file routes in `packages/worker/app/routes/` (`void.config.ts` sets `sourceDir` to `app`). To add an endpoint:

1. Write the handler in a module under `packages/worker/server/routes/` as an exported Hono handler, typed with its path so `c.req.param()` stays exact:

   ```ts
   export const getV1StatusesByIdContext = async (
     c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/context">,
   ) => { ... };
   ```

2. Re-export it from the route file for that path, named after the HTTP method. `[id]` is a path parameter; a path that also has children uses `index.ts`:

   ```ts
   // packages/worker/app/routes/api/v1/statuses/[id]/context.ts
   export { getV1StatusesByIdContext as GET } from "#server/routes/statuses/read";
   ```

`#server/*` is a package import of `@tstodon/worker` (`packages/worker/server/*`). Handlers are plain Hono handlers rather than `defineHandler` callbacks because Void types `c.env` with its own bindings, not the `Env` from `wrangler types`; at runtime `defineHandler(fn)` is `fn`. Void orders static segments before parameters (`accounts/lookup` wins over `accounts/[id]`) and the catch-all last.

- `app/middleware/01.cors.ts`: CORS for `/api/*` and the media paths.
- `app/middleware/02.rate-limit.ts`: rate limits (see "Rate limits" in `docs/reference/configuration.md`).
- `app/middleware/03.body-limit.ts`: request body caps, 413 over them (see "Request body limits" in `docs/reference/configuration.md`).
- `app/middleware/03.well-known.ts`: `/.well-known/webfinger` and `/.well-known/nodeinfo`. Void's route scanner skips dot directories, so these cannot be route files.
- `app/routes/[...].ts`: requests no route matched. GET and HEAD fall back to static assets; other methods get `{ "kind": "NotFound" }`.

Queue consumers, cron, Workflows, and Durable Objects are not HTTP routes:

- Cron jobs: `packages/worker/app/crons/*.ts` export `cron` (one expression or an array) and a `defineScheduled` default.
- Queue consumers: `packages/worker/app/queues/<queue-name>.ts` export a `defineQueue` default plus `maxBatchSize` / `maxBatchTimeout` / `maxRetries` / `maxConcurrency`. The file name is the Cloudflare queue name. Void has no `dead_letter_queue` option, so a queue file that dead-letters also exports `deadLetterQueue`, and the `tstodon:queue-dead-letter-queues` plugin (`packages/worker/void-plugins.ts`) writes it onto the consumer in both build outputs (`dist/ssr/wrangler.json` and `.cloudflare/output/`).
- Workflow and Durable Object classes: export them from `packages/worker/server/entry-classes.ts`. Void's generated entry only exports Void's own classes, so the `tstodon:export-entry-classes` plugin (`packages/worker/void-plugins.ts`) appends this module to it.

`main` in `void.config.ts` points at `server/entry-classes.ts` only so `wrangler types` can type the class bindings; Void replaces it in dev and build. Worker tests run in workerd against the build output (`packages/worker/dist/ssr/wrangler.json`), so they exercise Void's routing; `pnpm test` builds first. In tests the Worker's queue bindings send to queues no consumer reads (`queueProducers` in the root `vite.config.ts`), so a queued job runs only when its test runs it: `withQueueDrained`, or `holdQueue` and `drainHeld`, in `packages/worker/test/queue-hold.ts`, or `drainJobs` in `packages/worker/test/queue-capture.ts`. Worker tests do not reach the network either: the pool answers every fetch a test does not stub with a 502 at once, without a DNS lookup (`outboundService` in the same config), which the Worker handles as any remote server error. A test that needs a remote answer stubs `fetch` for its hosts (`vi.spyOn(globalThis, "fetch")`, or the fixtures in `packages/worker/test/`, such as `answerLinkPreviews` and the WebFinger and remote-actor fixtures).

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

Re-run `pnpm types:worker` after changing bindings or vars under `cloudflare` in `packages/worker/void.config.ts`. It runs `wrangler types` on that config and writes `packages/worker/worker-configuration.d.ts`. Secrets are declared in `packages/worker/app/env.ts`; the Worker reads them through its own schemas, not through `Env`.

After editing `prisma/sql/*.sql` or applying D1 migrations, regenerate TypedSQL:

```sh
pnpm db:migrate:local
pnpm prisma:generate
```

See [Prisma TypedSQL conventions](../architecture/prisma-typedsql.md).
