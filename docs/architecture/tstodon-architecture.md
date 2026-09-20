# tstodon Architecture

## Summary

`tstodon` is a TypeScript implementation of a Mastodon-compatible server designed for Cloudflare Workers. It follows the same platform mapping as cfwdon: D1 for relational state, R2 for media bodies, Queues and Workflows for outbound delivery, Durable Objects for streaming hubs, KV for short-lived caches, and Auth0 for protected API authentication.

Domain state is expressed as Zod 4.6 discriminated unions with a unified `kind` discriminant. HTTP routing is Hono. Those two layers stay separate.

## Goals

- Run a Mastodon-compatible API server on Cloudflare Workers.
- Keep persistence in D1 and media bodies in R2.
- Use Cloudflare primitives instead of long-lived processes: Queues, Workflows, Durable Objects, cron, KV, Images, Analytics Engine.
- Model every stateful concept as a `kind` discriminant, including errors, queue jobs, and ActivityPub activities.

## Non-Goals

- Port cfwdon's Rust code line-for-line.
- Claim behavioral Mastodon compatibility from route stubs.
- Put Queue, cron, Workflow, or Durable Object traffic through Hono.
- Implement a first-party OAuth authorization server while Auth0 is the authentication boundary.

## Workspace

- `packages/core`
  Result conversion, branded strings, `Sensitive`, exhaustiveness helpers.
- `packages/domain`
  Pure Zod discriminant models and transitions.
- `packages/worker`
  Cloudflare Worker runtime. Hono for HTTP. Entrypoint handlers for queue, cron, Workflows, and Durable Objects.

## HTTP Routing
<!-- constrained-by ../getting-started/development.md#http-routing -->

Hono matches paths and methods. Handlers parse unknown input with Zod, call domain companions, and map `Result` error `kind`s to status codes.

Do not encode domain state machines as Hono middleware. A follow request's `Pending | Accepted | None` graph belongs in `@tstodon/domain`, not in a route table.

## Cloudflare Mapping
<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

| Concern | Primitive |
| --- | --- |
| HTTP API, ActivityPub, discovery | Workers + Hono |
| Accounts, statuses, follows, outbox rows | D1 |
| Media blobs | R2 |
| Media transforms | Images |
| Streaming fan-out | Durable Object `StreamHub` |
| Outbox fan-out | Queues |
| Multi-step delivery | Workflows |
| Host-level DNS / SSRF cache | KV `REMOTE_DNS_CACHE` |
| Short-lived app cache | KV `APP_CACHE` |
| Maintenance | Cron triggers |
| Request metrics | Analytics Engine |
| Static UI | Workers Assets |
| Authn | Auth0 JWT vars |

Workers AI and Vectorize are the intended search/moderation path, but they are not bound yet because Workers AI is remote-billed even in local dev.

## Discriminant Modeling

Variants are objects with `kind` and `z.literal` discriminators. Nested unions replace optional fields. `z.getDiscriminatedOption` extracts a single variant schema. See the follow-request, outbox-delivery, and ActivityPub models in `packages/domain`.

## Authentication Model
<!-- derived-from ../reference/configuration.md#auth0-authentication-vars -->

Protected user-facing API routes will validate Auth0-issued RS256 JWTs, then map the configured e-mail claim to a local account. Public and federation routes stay unauthenticated at the application layer; ActivityPub inbox routes authenticate with HTTP signatures.

## Open Questions

- Which Mastodon routes should move from stubs to real handlers first?
- How much of outbound delivery should live in Queues versus Workflows?
- When to bind Vectorize / Workers AI for search without paying for unused local inference?
