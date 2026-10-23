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
pnpm run ci
```

`pnpm run ci` is the merge gate (`pnpm ci` is pnpm's frozen install). The toolchain is [Vite+](https://viteplus.dev/) (`vp`), configured in `vite.config.ts`:

- `pnpm check` (`vp check`) formats with Oxfmt, lints with Oxlint (type-aware rules via oxlint-tsgolint), and type-checks every package including tests. `pnpm typecheck` runs only the type check. Each package `tsconfig.json` is a standalone `noEmit` project; nothing is emitted by TypeScript.
- `pnpm test` (`vp test run`) runs Vitest 5. Worker tests run in workerd through `@cloudflare/vitest-plugin`.
- `pnpm dev` (`vp dev`) and `pnpm build` (`vp build .`) run the Worker through [Void](https://void.cloud) (`voidPlugin()`), which wraps `@cloudflare/vite-plugin` (Vite + Rolldown) and generates the Worker entry in `.void/` (gitignored). Bindings, vars, and resource IDs still come from `wrangler.jsonc`; Void adds `main`, cron `triggers`, and the queue consumer from `packages/worker/app`. Static assets come from `assets/` (Vite's `publicDir`). `wrangler deploy` uses the build output in `dist/` via `.wrangler/deploy/config.json`, so run `pnpm build` first (`pnpm run deploy` does both; plain `pnpm deploy` is pnpm's own command).
- Local state (D1, KV, R2, Durable Objects, Workflows) lives in `.wrangler/state`, the same place `wrangler ... --local` uses.

TypeScript targets ES2025 with `erasableSyntaxOnly` and `verbatimModuleSyntax`.

## HTTP routing

<!-- derived-from ../architecture/tstodon-architecture.md#http-routing -->

Void serves HTTP from file routes in `packages/worker/app/routes/` (`void.json` sets `sourceDir` to `packages/worker/app`). Until every endpoint has its own route file, `app/routes/[...].ts` forwards the rest to the Hono app in `packages/worker/src/app.ts`, whose route groups live in `packages/worker/src/routes/`. Void matches file routes before the catch-all, so a group can move into `app/routes/` (one file per path, `GET`/`POST`/... exports wrapped in `defineHandler`) without touching the others.

Queue consumers, cron, Workflows, and Durable Objects are not HTTP routes:

- Cron jobs: `packages/worker/app/crons/*.ts` export `cron` (one expression or an array) and a `defineScheduled` default.
- Queue consumers: `packages/worker/app/queues/<queue-name>.ts` export a `defineQueue` default plus `maxBatchSize` / `maxBatchTimeout` / `maxRetries`. The file name is the Cloudflare queue name. Void has no `max_concurrency` option; production sets it on the Terraform-managed consumer (see [Cloudflare deploy](../operations/cloudflare-deploy.md)).
- Workflow and Durable Object classes: export them from `packages/worker/src/entry-classes.ts`. Void's generated entry only exports Void's own classes, so the `tstodon:export-entry-classes` plugin in `vite.config.ts` appends this module to it.

`packages/worker/src/index.ts` wires the same handlers into a plain Worker module for `wrangler types` and the workerd test pool (`wrangler.jsonc` `main`). Keep it in step with `packages/worker/app`.

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

Re-run `pnpm types:worker` after changing bindings in `wrangler.jsonc`.

After editing `prisma/sql/*.sql` or applying D1 migrations, regenerate TypedSQL:

```sh
pnpm exec wrangler d1 migrations apply tstodon --local
pnpm prisma:generate
```

See [Prisma TypedSQL conventions](../architecture/prisma-typedsql.md).
