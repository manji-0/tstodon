# tstodon

`tstodon` is a TypeScript Mastodon-compatible server for Cloudflare Workers. It takes the same platform split as [`cfwdon`](https://github.com/manji-0/cfwdon): Workers for the request path, D1 for relational state, R2 for media, Queues and Workflows for delivery, Durable Objects for streaming, and Auth0 as the authentication boundary.

The TypeScript domain is modeled with [Zod 4.6](https://zod.dev) `z.discriminatedUnion` values. States, errors, ActivityPub activities, and queue jobs are all `kind`-discriminated unions rather than optional-field bags.

The project is early software. The [local core](docs/planning/local-core.md) classifies implemented behavior, placeholders, and out-of-scope work. Behavioral Mastodon parity is still incomplete.

## Status

- TypeScript workspace with `@tstodon/core`, `@tstodon/domain`, and `@tstodon/worker`
- Hono for HTTP routing (Mastodon API, WebFinger, NodeInfo, ActivityPub, static assets)
- Cloudflare bindings for D1, R2, KV, Queues, Durable Objects, Workflows, Images, Analytics Engine, cron, and observability
- Zod 4.6 discriminant domain models for status composition, follow requests, outbox delivery, inbox activities, notifications, and registration
- Local `DEV_BEARER_SECRET` authentication that provisions D1 accounts

## Requirements

- Node.js 24+
- `pnpm`
- Cloudflare account access for Workers, D1, and R2 operations
- `wrangler` authentication for deploys and remote resource changes

Optional: `devbox shell` installs Node, pnpm, and wrangler from [devbox.json](devbox.json).

## Quick Start
<!-- derived-from ./docs/getting-started/clone-and-run.md -->

```sh
pnpm install
pnpm types:worker
pnpm test
pnpm dev
```

Local routes that depend on D1, R2, or Auth0 need matching local or remote bindings. Start with [Clone And Run](docs/getting-started/clone-and-run.md).

## Documentation
<!-- derived-from ./docs/architecture/tstodon-architecture.md -->

- [Architecture](docs/architecture/tstodon-architecture.md)
- [Local Core](docs/planning/local-core.md)
- [Clone And Run](docs/getting-started/clone-and-run.md)
- [Development Workflow](docs/getting-started/development.md)
- [Configuration Reference](docs/reference/configuration.md)
- [Cloudflare Deploy Checklist](docs/operations/cloudflare-deploy.md)

## Contributing
<!-- constrained-by ./docs/getting-started/development.md -->

Before opening a change, run:

```sh
pnpm ci
```

Use conventional commit messages.

## License

AGPL-3.0-or-later.
