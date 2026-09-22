# AGENTS.md

This file tells AI coding agents how to work in this repository without losing project context.

## Project Shape

`tstodon` is a Mastodon-compatible server for Cloudflare Workers, written in TypeScript. The workspace is split into:

- `packages/core` for Result/schema helpers, branded IDs, and `Sensitive`.
- `packages/domain` for Zod 4.6 `kind`-discriminated domain models.
- `packages/worker` for the Worker runtime. Hono owns HTTP. Queue, cron, Workflows, and Durable Objects stay on the Worker entrypoint.

Operational docs live under `docs/`.

## HTTP vs everything else

Use Hono for HTTP route matching and middleware. Do not invent a parallel HTTP router.

Do not send Queue, scheduled, Workflow, or Durable Object traffic through Hono. Those handlers live next to `export default` in `packages/worker/src/index.ts`.

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
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
pnpm dev
pnpm run ci
```

`pnpm run ci` is the minimum validation gate before handing back implementation work (`pnpm ci` is pnpm's frozen install).

## Setup And Deployment Docs

For a fresh clone, start with:

- `README.md`
- `docs/getting-started/clone-and-run.md`
- `docs/getting-started/development.md`
- `docs/planning/local-core.md`
- `docs/reference/configuration.md`
- `docs/operations/cloudflare-deploy.md`

Do not commit private Cloudflare values, Access audience secrets, API keys, or private key material.

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
