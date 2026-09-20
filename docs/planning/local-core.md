# Local Core

This is the planning source for `tstodon`'s current slice: a local-only Mastodon-compatible core on Cloudflare Workers. It records what is guaranteed, what is an empty placeholder, and what is out of scope. Behavioral Mastodon parity and a generated upstream route inventory are not claimed here.

## Principles
<!-- constrained-by ../architecture/tstodon-architecture.md#goals -->

- Prefer correct signatures, visibility, ownership, and idempotency over adding routes.
- Keep Hono on HTTP only. Queue, cron, Workflows, and Durable Objects stay on the Worker entrypoint.
- Domain state uses Zod 4.6 `kind` discriminants. HTTP `type` fields stay at the Mastodon JSON boundary.
- Local accounts on this instance are the only guaranteed actors and authors.

## Capability status
<!-- derived-from #principles -->
<!-- constrained-by ../getting-started/development.md#http-routing -->
<!-- dagayn: implemented-by packages/worker/src/app.ts::app -->

Labels:

- **implemented** — local accounts can exercise the behavior; tests should cover the main path.
- **placeholder** — the route exists with an empty or conservative response; do not treat it as compatibility.
- **out of scope** — not in this slice.

### Implemented

| Method | Path |
| --- | --- |
| GET | `/healthz` |
| GET | `/login` |
| GET | `/api/v1/instance` |
| GET | `/api/v2/instance` |
| GET | `/.well-known/webfinger` |
| GET | `/.well-known/nodeinfo` |
| GET | `/nodeinfo/2.0` |
| POST | `/api/v1/apps` |
| GET | `/api/v1/apps/verify_credentials` |
| POST | `/oauth/token` |
| GET | `/api/v1/accounts/verify_credentials` |
| PATCH | `/api/v1/accounts/update_credentials` |
| GET | `/api/v1/accounts/lookup` |
| GET | `/api/v1/accounts/relationships` |
| GET | `/api/v1/accounts/:id` |
| GET | `/api/v1/accounts/:id/statuses` |
| GET | `/api/v1/accounts/:id/followers` |
| GET | `/api/v1/accounts/:id/following` |
| POST | `/api/v1/accounts/:id/follow` |
| POST | `/api/v1/accounts/:id/unfollow` |
| POST | `/api/v1/statuses` |
| GET | `/api/v1/statuses/:id` |
| DELETE | `/api/v1/statuses/:id` |
| POST | `/api/v1/statuses/:id/favourite` |
| POST | `/api/v1/statuses/:id/unfavourite` |
| POST | `/api/v1/statuses/:id/reblog` |
| POST | `/api/v1/statuses/:id/unreblog` |
| POST | `/api/v1/statuses/:id/bookmark` |
| POST | `/api/v1/statuses/:id/unbookmark` |
| GET | `/api/v1/favourites` |
| GET | `/api/v1/bookmarks` |
| GET | `/api/v1/timelines/public` |
| GET | `/api/v1/timelines/home` |
| GET | `/api/v1/timelines/tag/:hashtag` |
| POST | `/api/v1/media` |
| POST | `/api/v2/media` |
| GET | `/media/:id` |
| GET | `/api/v1/notifications` |
| GET | `/api/v1/polls/:id` |
| POST | `/api/v1/polls/:id/votes` |
| GET | `/api/v1/filters` |
| POST | `/api/v1/filters` |
| DELETE | `/api/v1/filters/:id` |
| GET | `/api/v2/filters` |
| POST | `/api/v1/reports` |
| GET | `/api/v1/search` |
| GET | `/api/v2/search` |
| GET | `/users/:username` |
| GET | `/users/:username/statuses/:id` |
| GET | `/users/:username/outbox` |
| GET | `/users/:username/followers` |
| GET | `/users/:username/following` |
| POST | `/users/:username/inbox` |
| POST | `/inbox` |

Search is D1 `LIKE` over local usernames and status text. Tag timelines match `#hashtag` in local public notes. Inbox accepts signed Follow / Undo / Like / Announce that target local actor or status URLs from a local actor key.

### Placeholder

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/v1/statuses/:id/context` | `{ ancestors: [], descendants: [] }` |
| GET | `/api/v1/timelines/direct` | `[]` |
| GET | `/api/v1/custom_emojis` | `[]` |
| GET | `/api/v1/announcements` | `[]` |
| GET | `/api/v1/lists` | `[]` |
| GET | `/api/v1/suggestions` | `[]` |
| GET | `/api/v1/conversations` | `[]` |
| GET | `/api/v1/markers` | `{}` |
| GET | `/api/v1/trends` | `[]` |
| GET | `/api/v1/trends/tags` | `[]` |
| GET | `/api/v1/trends/statuses` | `[]` |
| GET | `/api/v1/trends/links` | `[]` |
| GET | `/api/v1/instance/peers` | `[]` |
| GET | `/api/v1/instance/rules` | `[]` |
| GET | `/api/v1/instance/activity` | `[]` |
| GET | `/api/v1/directory` | `[]` |
| GET | `/api/v1/streaming` | Durable Object WebSocket hub without write-time fan-out |

`StreamHub`, `OutboxDeliveryWorkflow`, and expired-poll cron remain entrypoint stubs around the HTTP core.

### Out of scope
<!-- derived-from #principles -->

- Remote actor / remote status persistence
- Fetching remote keys for non-local inbox actors
- Workers AI / Vectorize search
- Mastodon admin APIs
- A generated upstream route inventory
- A first-party OAuth authorization server
- A first-party web UI

## Quality bar
<!-- constrained-by ../architecture/tstodon-architecture.md#discriminant-modeling -->
<!-- constrained-by ../getting-started/development.md#domain-changes -->

- Domain modules are `kind` discriminated unions with companion `schema` / `parse` / transitions. Domain code does not throw Zod or HTTP errors.
- Boundaries (HTTP bodies, D1 rows, queue payloads, JSON columns) parse with `schemaResult`. The only allowed TypeScript assertions are `as const` and `as const satisfies Type`.
- PII fields use `Sensitive`.
- Hono handlers map `Result` error `kind`s to status codes. Domain graphs such as follow `Pending | Accepted | None` stay out of middleware.
- Worker tests load D1 migrations and parse JSON responses with Zod. They do not use `json() as { id: string }`.

## Authentication
<!-- derived-from ../reference/configuration.md#local-development-bearer -->
<!-- constrained-by ../reference/configuration.md#workos-authentication-vars -->
<!-- dagayn: implemented-by packages/worker/src/auth.ts::authenticate -->

Protected API routes accept `Authorization: Bearer ${DEV_BEARER_SECRET}:${email}` for local tests (`:admin` suffix elevates to `{ kind: "Admin" }`). Production bearers are WorkOS AuthKit access tokens, verified against the environment JWKS with issuer `https://api.workos.com` and audience `https://example.com/api`. The JWT template adds `email` from the WorkOS user and copies user metadata onto claim `fedi`. Role is `fedi["fedi/role"]` (`admin` | `user`). The Worker provisions a local account from the e-mail claim, and falls back to a user lookup when `email` is missing. An empty local secret skips the test bearer. `GET /login` starts the AuthKit authorization code flow when `WORKOS_CLIENT_ID` is set. `requireAdmin` maps non-admin sessions to `kind: Forbidden`.

## Federation
<!-- constrained-by ../architecture/tstodon-architecture.md#http-routing -->

Public discovery and actor documents are unauthenticated. Inbox requests must carry a draft-cavage `Signature` (and matching `Digest`). Verification uses the local actor's stored public key. Missing, unverifiable, or non-local actor keys return `kind: InvalidSignature`.

Outbound Create / Announce jobs expand local followers and sign POSTs to remote inboxes. Same-host inboxes are skipped.

## Next
<!-- derived-from #out-of-scope -->

- Persist remote actors so inbound signatures can use cached keys.
- Decide Queue versus Workflow ownership for delivery retries.
- Bind Vectorize / Workers AI only when local search cost is acceptable.
