# tstodon Architecture

## Summary

`tstodon` is a TypeScript implementation of a Mastodon-compatible server designed for Cloudflare Workers. It follows the same platform mapping as cfwdon: D1 for relational state, R2 for media bodies, Queues and Workflows for outbound delivery, Durable Objects for streaming hubs, KV for short-lived caches, and Cloudflare Access (with WorkOS as the IdP) for protected API authentication.

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
- Implement a first-party OAuth authorization server while Cloudflare Access is the authentication boundary.

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

| Concern                                  | Primitive                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP API, ActivityPub, discovery         | Workers + Hono                                                                                                                                                                                                                                                                                                                |
| Accounts, statuses, follows, outbox rows | D1 (see [write strategy](./d1-write-strategy.md), [heavy scenarios](./d1-heavy-scenarios.md), [checklist](./d1-writes.md); ADRs: [json_each](./adr-json-each-membership.md), [TypedSQL exec](./adr-typedsql-d1-execution.md), [migrations](./adr-wrangler-migrations-sot.md), [timeline SQL](./adr-variable-timeline-sql.md)) |
| Media blobs                              | R2                                                                                                                                                                                                                                                                                                                            |
| Media transforms                         | Images                                                                                                                                                                                                                                                                                                                        |
| Streaming fan-out                        | Durable Object `StreamHub`                                                                                                                                                                                                                                                                                                    |
| Outbox fan-out                           | Queues                                                                                                                                                                                                                                                                                                                        |
| Multi-step delivery                      | Workflows                                                                                                                                                                                                                                                                                                                     |
| Host-level DNS / SSRF cache              | KV `REMOTE_DNS_CACHE`                                                                                                                                                                                                                                                                                                         |
| Short-lived app cache                    | KV `APP_CACHE`                                                                                                                                                                                                                                                                                                                |
| Maintenance                              | Cron triggers                                                                                                                                                                                                                                                                                                                 |
| Request metrics                          | Analytics Engine                                                                                                                                                                                                                                                                                                              |
| Static UI                                | Workers Assets                                                                                                                                                                                                                                                                                                                |
| Authn                                    | Cloudflare Access JWT vars                                                                                                                                                                                                                                                                                                    |

Workers AI and Vectorize are the intended search/moderation path, but they are not bound yet because Workers AI is remote-billed even in local dev.

## Discriminant Modeling

Variants are objects with `kind` and `z.literal` discriminators. Nested unions replace optional fields. `z.getDiscriminatedOption` extracts a single variant schema. See the follow-request, outbox-delivery, and ActivityPub models in `packages/domain`.

## Authentication Model

<!-- derived-from ../reference/configuration.md#cloudflare-access-authentication-vars -->

Protected user-facing API routes authenticate with a Cloudflare Access JWT from `Cf-Access-Jwt-Assertion` or `Authorization: Bearer <Access JWT>`. The Worker verifies the token against the Access JWKS (`CF_ACCESS_TEAM_DOMAIN` / optional `CF_ACCESS_JWKS_JSON`), provisions a local account from the `email` claim, and maps `CF_ACCESS_ADMIN_GROUPS` onto `{ kind: "Admin" }` via JWT `groups` / `custom.groups`. WorkOS is the Access identity provider in Zero Trust, not a direct Worker call. Local tests mint Access-shaped JWTs with the fixture keypair. Public discovery routes stay unauthenticated. ActivityPub inbox routes require a valid HTTP Signature; local actors use the stored account key and remote actors use a cached (or freshly fetched) `RemoteActor` key. Unsigned or unverifiable requests are `InvalidSignature`.

## Implemented Surface

<!-- derived-from ../planning/local-core.md#capability-status -->

The HTTP surface is classified in [Local Core](../planning/local-core.md): implemented local behavior, intentional placeholders, and out-of-scope work. Do not infer Mastodon compatibility from placeholder routes.

Queue, cron, Workflow, and Durable Object traffic stay on the Worker entrypoint. Hono only matches HTTP.

Queue `OUTBOX_PROCESS_QUEUE` owns `ExpandFollowers` fan-out and `ProcessExpiredPolls`. Workflow `OUTBOX_DELIVERY_WORKFLOW` owns per-inbox POST retries. `DeliverTarget` on the queue only starts that workflow (legacy or replay). `StreamHub` receives write-time `update` / `notification` / `status.update` events per account.

## Open Questions

<!-- constrained-by ../planning/local-core.md#out-of-scope -->

- Defer Vectorize / Workers AI until local search cost is acceptable.
