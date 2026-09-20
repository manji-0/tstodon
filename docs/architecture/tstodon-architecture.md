# tstodon Architecture

## Summary

`tstodon` is a TypeScript implementation of a Mastodon-compatible server designed for Cloudflare Workers. It follows the same platform mapping as cfwdon: D1 for relational state, R2 for media bodies, Queues and Workflows for outbound delivery, Durable Objects for streaming hubs, KV for short-lived caches, and WorkOS AuthKit for protected API authentication.

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
- Implement a first-party OAuth authorization server while WorkOS is the authentication boundary.

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
| Authn | WorkOS AuthKit JWT vars |

Workers AI and Vectorize are the intended search/moderation path, but they are not bound yet because Workers AI is remote-billed even in local dev.

## Discriminant Modeling

Variants are objects with `kind` and `z.literal` discriminators. Nested unions replace optional fields. `z.getDiscriminatedOption` extracts a single variant schema. See the follow-request, outbox-delivery, and ActivityPub models in `packages/domain`.

## Authentication Model
<!-- derived-from ../reference/configuration.md#workos-authentication-vars -->

Protected user-facing API routes authenticate with a local `DEV_BEARER_SECRET` token of the form `Bearer ${secret}:${email}` in tests (`:admin` for `{ kind: "Admin" }`), or a WorkOS AuthKit access token as `Bearer ${accessToken}` in production. Role comes from WorkOS user metadata `fedi/role` (`admin` | `user`) via JWT claim `fedi`. The Worker provisions a local account from the verified e-mail on first use. An empty local secret skips the bearer shortcut and leaves WorkOS as the only JWT path. Public discovery routes stay unauthenticated. ActivityPub inbox routes require a valid HTTP Signature; local actors use the stored account key and remote actors use a cached (or freshly fetched) `RemoteActor` key. Unsigned or unverifiable requests are `InvalidSignature`.

## Implemented Surface
<!-- derived-from ../planning/local-core.md#capability-status -->

The HTTP surface is classified in [Local Core](../planning/local-core.md): implemented local behavior, intentional placeholders, and out-of-scope work. Do not infer Mastodon compatibility from placeholder routes.

Queue, cron, Workflow, and Durable Object traffic stay on the Worker entrypoint. Hono only matches HTTP.

## Open Questions
<!-- constrained-by ../planning/local-core.md#out-of-scope -->

- How much of outbound delivery should live in Queues versus Workflows?
- When to bind Vectorize / Workers AI for search without paying for unused local inference?
