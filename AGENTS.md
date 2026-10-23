# AGENTS.md

This file tells AI coding agents how to work in this repository without losing project context.

## Project Shape

`tstodon` is a Mastodon-compatible server for Cloudflare Workers, written in TypeScript. The workspace is split into:

- `packages/core` for Result/schema helpers, branded IDs, and `Sensitive`.
- `packages/domain` for Zod 4.6 `kind`-discriminated domain models.
- `packages/worker` for the Worker runtime, built, served, and deployed by [Void](https://void.cloud). `packages/worker` is the Void project root (`vite.config.ts` with `voidPlugin()`, `void.json`, `wrangler.jsonc`, `assets/`); Void reads its conventions from `packages/worker/app` (`void.json` `sourceDir`): `routes/`, `middleware/`, `crons/`, `queues/`, `db/migrations/`. Shared code stays in `packages/worker/src`.

Operational docs live under `docs/`.

## HTTP vs everything else

Void generates the Worker entry (`.void/entry.ts`) and owns HTTP routing (on Hono). Each path is a file under `packages/worker/app/routes/` (`[id]` for params) that re-exports its handlers as `GET` / `POST` / ... from `#src/routes/*`; the handlers are plain Hono handlers typed `Context<{ Bindings: Env }, "/the/path">`. Request-wide middleware lives in `packages/worker/app/middleware/` (numeric prefix = order). `app/routes/[...].ts` answers requests no route matched. Void skips dot directories, so `/.well-known/*` is served by `app/middleware/02.well-known.ts`. Do not invent a parallel HTTP router.

Do not send Queue, scheduled, Workflow, or Durable Object traffic through HTTP routes. Cron jobs live in `packages/worker/app/crons/`, queue consumers in `packages/worker/app/queues/` (the file name is the queue name). Workflow and Durable Object classes are exported from `packages/worker/src/entry-classes.ts`, which the `tstodon:export-entry-classes` plugin in `packages/worker/void-plugins.ts` appends to Void's entry. Worker tests run against the Void build in `packages/worker/dist/` (`pnpm test` builds first).

Hono handlers are a boundary: parse with Zod, call domain companions, map `Result` error `kind`s to HTTP. Domain transitions stay pure.

## Zod discriminant conventions

- Discriminator property is always `kind`.
- Write each variant with `z.literal("...")`, not `z.enum`.
- Compose nested `z.discriminatedUnion` instead of optional fields.
- Look up a variant with `z.getDiscriminatedOption(union, kind)`.
- Companion objects own `schema` and `parse`.
- Parse unknown input with `schemaResult`; do not use `as` except `as const` and `as const satisfies Type`.

## Development Commands

Run commands from the repository root.

```sh
pnpm install
pnpm types:worker
pnpm check
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
pnpm dev
pnpm build
pnpm db:migrate:local
pnpm run ci
pnpm run deploy
```

The toolchain is Vite+ (`vp`): the root `vite.config.ts` holds the Vitest, Oxlint, and Oxfmt settings; `packages/worker/vite.config.ts` holds the Void build. Tests import from `vite-plus/test`, not `vitest`.

`pnpm run ci` is the minimum validation gate before handing back implementation work (`pnpm ci` is pnpm's frozen install).

## Setup And Deployment Docs

For a fresh clone, start with:

- `README.md`
- `docs/getting-started/clone-and-run.md`
- `docs/getting-started/development.md`
- `docs/planning/local-core.md`
- `docs/reference/configuration.md`
- `docs/operations/cloudflare-deploy.md`

D1 migrations are `packages/worker/app/db/migrations/*.sql`, applied by Wrangler (`pnpm db:migrate:local`; remote via `pnpm run deploy`). A migration that drops a table (e.g. a SQLite table rebuild) needs a `-- void:allow-destructive` line or Void's deploy gate refuses it.

Do not commit private Cloudflare values, `BETTER_AUTH_SECRET`, API keys, or private key material.

## Markdown Documentation Policy

When authoring or editing Markdown, declare real dependencies with HTML directive comments so dagayn can index the document graph.

Use one of:

```markdown
<!-- constrained-by ./path.md#section -->
<!-- blocked-by ./path.md#section -->
<!-- supersedes ./path.md -->
<!-- derived-from #earlier-section -->
```

Place the directive immediately under the heading whose content depends on the target. Do not invent dependencies just to add comments.

## Git

Use conventional commit messages.
