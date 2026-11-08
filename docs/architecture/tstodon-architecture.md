# tstodon Architecture

## Summary

<!-- derived-from ../reference/configuration.md#authentication -->

`tstodon` is a TypeScript implementation of a Mastodon-compatible server designed for Cloudflare Workers. It follows the same platform mapping as cfwdon: D1 for relational state, R2 for media bodies, Queues and Workflows for outbound delivery, Durable Objects for streaming hubs, KV for short-lived caches, and Cloudflare Access for browser login behind a first-party Mastodon OAuth 2 server for API authentication.

Domain state is expressed as Zod 4.6 discriminated unions with a unified `kind` discriminant. HTTP routing is Hono. Those two layers stay separate.

## Goals

- Run a Mastodon-compatible API server on Cloudflare Workers.
- Keep persistence in D1 and media bodies in R2.
- Use Cloudflare primitives instead of long-lived processes: Queues, Workflows, Durable Objects, cron, KV, Images, Analytics Engine.
- Model every stateful concept as a `kind` discriminant, including errors, queue jobs, and ActivityPub activities.

## Non-Goals

- Port cfwdon's Rust code line-for-line.
- Claim behavioral Mastodon compatibility from route stubs.
- Put Queue, cron, Workflow, or Durable Object traffic through HTTP routes.

## Workspace

- `packages/core`
  Result conversion, branded strings, `Sensitive`, exhaustiveness helpers.
- `packages/domain`
  Pure Zod discriminant models and transitions.
- `packages/worker`
  Cloudflare Worker runtime, built by Void. Void file routes (`app/routes/`) and Hono for HTTP. `app/crons/` and `app/queues/` for cron and queue handlers; Workflow and Durable Object classes exported from the generated entry.

## HTTP Routing

<!-- constrained-by ../getting-started/development.md#http-routing -->

Void file routes (`packages/worker/app/routes/`) match paths and methods on Hono. Handlers parse unknown input with Zod, call domain companions, and map `Result` error `kind`s to status codes.

Do not encode domain state machines as Hono middleware. A follow request's `Pending | Accepted | None` graph belongs in `@tstodon/domain`, not in a route table.

## Cloudflare Mapping

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->
<!-- derived-from ../reference/configuration.md#authentication -->

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
| Authn                                    | Cloudflare Access JWT (passkeys or an IdP such as WorkOS) + D1 OAuth tables; Better Auth stores the linked user and session                                                                                                                                                                                                   |

Workers AI and Vectorize are the intended search/moderation path, but they are not bound yet because Workers AI is remote-billed even in local dev.

## Discriminant Modeling

Variants are objects with `kind` and `z.literal` discriminators. Nested unions replace optional fields. `z.getDiscriminatedOption` extracts a single variant schema. See the follow-request, outbox-delivery, and ActivityPub models in `packages/domain`.

## Read and Write Contracts

A use case that reads or writes storage takes each operation as a parameter. The operation's type is a function type in `packages/domain`, beside the concept it serves: reads in `<concept>-resolver.ts` (or with the concept, as `FindThreadParent` in `thread-status.ts`), writes in `<concept>-store.ts`. Contracts name domain types and fail with `RepositoryError`; there is no `ports/` directory and no SQL in the domain. The D1 functions in `packages/worker/server/*-store.ts` stay the implementations. The composition point (an inbox handler, a route, or an `env`-taking entry such as `notifyAccount`) wires them as `(input) => storeFunction(env.DB, input)`. Each use case receives only the operations it calls, so its unit tests pass in-memory functions instead of D1. Examples: `answerOutboundFollow`, `listThreadAncestors`, `deliverNotification`, `withdrawRemoteStatus` and `recordInboxFollow`. Add a contract only when a use case takes it; a store function with no such use case stays a plain D1 function.

## Remote Actor Domains

A remote actor has two hosts. Its account domain (`remote_actors.domain`, hostname in `host`) is the domain of the handle WebFinger confirms, as Mastodon's `check_webfinger!` does: `alice@example.com` can be served from `https://social.example.com/users/alice`. Its URI host (`uri_host`, migration 0107) is the host that serves the actor document and its key.

Actor fetch (`cacheFetchedActor` in `packages/worker/server/remote-actor-fetch.ts`) records the round trip as a `WebfingerConfirmation` (`packages/domain/src/webfinger-confirmation.ts`) and writes the handle as `WebfingerConfirmation.handleWrite` says:

- `Confirmed` stores the confirmed handle with `last_webfingered_at` set to now, and moves every other confirmed row cached under that handle back to its own URI authority, so a handle names the actor WebFinger confirmed last.
- `Mismatch` stores the URI authority. It is any answer that does not confirm the handle: an answer for another actor, a subject that does not loop back, a 404 or 410, and, when the stored handle is on another domain than the URI's, anything but that domain's own confirmation once the lookups from the URI authority failed.
- `Unavailable` keeps the handle and its `last_webfingered_at` as the row holds them when it is written (`upsertRemoteActorKeepingHandle`), not as they were read before the round trip, so a confirmation another actor made meanwhile stands. An actor not cached yet takes the URI authority.
- `Refused` refuses the actor when its claimed account domain is suspended or not on the allow list.

A lookup follows up to three redirects, as Mastodon's `Webfinger` does through `Request` (`max_hops: 3`), because a split-domain server (Mastodon's `LOCAL_DOMAIN` with `WEB_DOMAIN`) redirects its account domain's WebFinger to its own host. Every hop passes the same host guard as the first request (`isFederatedHostRefused`: private ranges, suspended hosts, the allow list) and must use HTTPS (plain HTTP only for a loopback host on `FEDERATION_ALLOW_HOSTS`), a URL already fetched is not fetched again, and one 5 s deadline covers the chain. Only the final answer's `subject` and `self` count, and they still speak for the handle first asked: the asked domain chose where to redirect, and the round trip below compares the answer with that handle, never with the host a redirect pointed to. A lookup fails when it times out, or answers a 5xx, a redirect it does not follow (a fourth redirect, a loop, a refused host, plain HTTP), a 4xx other than 404 or 410, an unreadable body, or no `self` link. The round trip ends `Unavailable` only when such a failure comes from a domain the URI host does not control for a stored handle on another domain: when the stored handle is the URI authority's own and its lookup fails; when the URI authority's answer names the stored handle and the stored domain's lookup fails; or when the lookups from the URI authority fail (at the URI host, or at another domain it names) and the stored handle's own lookup fails too. A failure at the URI host alone never keeps a handle on another domain: the stored handle is then looked up at its own domain, as Mastodon's `ResolveAccountService` asks the handle side, and stays only when that answer names it and links to the actor. An actor's own `Update` applies the document under the stored handle without asking WebFinger, the same way as `Unavailable`.

A handle lookup's own WebFinger answer only stands in for the lookup it repeats: the first step when the asked handle is the URI authority's, else the second once the URI authority names it. A third party therefore cannot rename anyone. An actor id whose authority is not printable ASCII (a Unicode host, which SQLite's `lower` cannot fold), or whose text reads otherwise than its parsed host and port, is refused, so SQL and TypeScript always read the same host. A row is only ever moved back to its `uri_authority` once it was confirmed, and a confirmed row's id passed that check; a row never confirmed already holds its own URI's host.

A handle is confirmed again a day after its last confirmation, in two bounded ways:

- On use. A mention (and so a direct message), a `resolve=true` search or lookup, a CSV import, and an alias or move resolve the handle through `resolveRemoteActorByHandle`. A cached holder is used as it is until it is due; a due holder is claimed (`claimRemoteActorRefresh`, one conditional UPDATE) and the handle's own WebFinger is asked. A 404 or 410 there, or an answer naming another account or actor, moves the holders it does not name back to their URI authority; the actor it links is fetched and run through the round trip. While the handle's own domain does not answer, the cached holder is kept; while the linked actor's document does not answer, that actor is used as cached, under the handle the settling left it. Each use costs at most seventeen subrequests (the handle's lookup, the linked actor's document and up to three lookups in its round trip, when that actor is stored under a third domain; each lookup is up to four requests, one plus three redirects), and the claim keeps an unreachable actor from being asked again for a day.
- On the hourly cron (`refreshStaleRemoteActors`, `packages/worker/server/remote-actor-refresh.ts`). It refreshes every due actor, the longest waiting first, until none is due or the run's budget is spent: at most 200 actors, none started after 45 s, four at a time. Each is claimed just before its fetch, so a cron run and a handle lookup never both refresh it. An actor costs at most thirteen subrequests (its document and three lookups of up to four requests each), so a run stays at most 2600 fetches and about 610 D1 queries (claim, find and write per actor), inside the Workers Paid limits of 10,000 subrequests and 1000 D1 queries per invocation, of which the D1 limit binds first, and the cron refreshes up to 4800 actors a day. When an actor's document does not answer and its handle was confirmed, that handle's own WebFinger alone decides whether it keeps it, so a former holder cannot keep a domain by failing its server altogether.

Rows are keyed by actor URI, not by handle. When a handle moves to another actor, follows, list memberships, blocks, mutes and notes stay with the actor URI they were made on, which now shows under its own URI authority. Mastodon keys an account by handle and hands that record, with its relationships, to the newly confirmed URI.

Every domain rule matches either host. An instance rule (an admin's suspension, silence, `reject_media` or `reject_reports`, and the allow list) and a user's domain block both apply when they name the account domain or the URI host. TypeScript asks `RemoteActor.hostnames` or `RemoteActor.onAnyHost`; SQL matches `host` or `uri_host`. An actor therefore cannot escape a rule on the server that serves it by confirming a domain elsewhere, and a user's block made on the URI host keeps working once the account domain is confirmed. Mastodon matches a user's block against `account.domain` only; matching both only ever blocks more.

## Authentication Model

<!-- derived-from ../reference/configuration.md#authentication -->

People sign in through Cloudflare Access. Access checks a passkey of its own, or an identity provider such as WorkOS, and the Worker verifies `Cf-Access-Jwt-Assertion` (`packages/worker/server/access-jwt.ts`). A new address is provisioned when registrations are open (`packages/worker/server/access-session.ts`): the username comes from the address, and the Better Auth user and session rows are the account link and the web app token's secret, not a second login. Mastodon clients register at `/api/v1/apps` and get bearer tokens from the Worker's own OAuth 2 server (`/oauth/authorize` consent on that Access session, `/oauth/token`, PKCE, scopes), stored as digests in D1. Protected API routes resolve the bearer token to its account and scopes; the Better Auth admin plugin's `admin` role maps onto `{ kind: "Admin" }`. Public discovery routes stay unauthenticated. ActivityPub inbox routes require a valid HTTP Signature; local actors use the stored account key and remote actors use a cached (or freshly fetched) `RemoteActor` key. Unsigned or unverifiable requests are `InvalidSignature`.

## Implemented Surface

<!-- derived-from ../planning/local-core.md#capability-status -->

The HTTP surface is classified in [Local Core](../planning/local-core.md): implemented local behavior, intentional placeholders, and out-of-scope work. Do not infer Mastodon compatibility from placeholder routes.

Queue, cron, Workflow, and Durable Object traffic stay on the Worker entrypoint that Void generates. HTTP routes only match HTTP.

Queue `OUTBOX_PROCESS_QUEUE` owns `ExpandFollowers` fan-out and `ProcessExpiredPolls`. Workflow `OUTBOX_DELIVERY_WORKFLOW` owns per-inbox POST retries. `DeliverTarget` on the queue only starts that workflow (legacy or replay). `StreamHub` receives write-time `update` / `notification` / `status.update` events per account.

## Open Questions

<!-- constrained-by ../planning/local-core.md#out-of-scope -->

- Defer Vectorize / Workers AI until local search cost is acceptable.
