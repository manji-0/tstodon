# Development Workflow

## Commands

```sh
pnpm types:worker
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt
pnpm fmt:check
pnpm dev
pnpm run ci
```

`pnpm run ci` is the merge gate (`pnpm ci` is pnpm's frozen install). Lint uses oxlint; formatting uses oxfmt.

## HTTP routing

<!-- derived-from ../architecture/tstodon-architecture.md#http-routing -->

Add HTTP endpoints as Hono routes under `packages/worker/src/routes/`. Register them from `packages/worker/src/app.ts`.

Queue consumers, cron, Workflows, and Durable Objects are not Hono routes.

## Domain changes

Put new state in `packages/domain` as a `z.discriminatedUnion("kind", ...)` plus a companion object. One concept per file. Tests live next to the module.

## Generated types

Re-run `pnpm types:worker` after changing bindings in `wrangler.jsonc`.
