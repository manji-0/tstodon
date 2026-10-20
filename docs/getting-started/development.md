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
- `pnpm dev` (`vp dev`) and `pnpm build` (`vp build .`) run the Worker through `@cloudflare/vite-plugin` (Vite + Rolldown). Static assets come from `assets/` (Vite's `publicDir`). `wrangler deploy` uses the build output in `dist/` via `.wrangler/deploy/config.json`, so run `pnpm build` first (`pnpm run deploy` does both; plain `pnpm deploy` is pnpm's own command).

TypeScript targets ES2025 with `erasableSyntaxOnly` and `verbatimModuleSyntax`.

## HTTP routing

<!-- derived-from ../architecture/tstodon-architecture.md#http-routing -->

Add HTTP endpoints as Hono routes under `packages/worker/src/routes/`. Register them from `packages/worker/src/app.ts`.

Queue consumers, cron, Workflows, and Durable Objects are not Hono routes.

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
