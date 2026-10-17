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
- **placeholder** — the route exists with an empty or conservative response; do not treat it as compatibility. No placeholder routes remain.
- **out of scope** — not in this slice.

### Implemented

| Method | Path                                        |
| ------ | ------------------------------------------- |
| GET    | `/healthz`                                  |
| GET    | `/login`                                    |
| GET    | `/api/v1/instance`                          |
| GET    | `/api/v1/instance/rules`                    |
| GET    | `/api/v2/instance`                          |
| GET    | `/api/v1/custom_emojis`                     |
| GET    | `/api/v1/admin/custom_emojis`               |
| POST   | `/api/v1/admin/custom_emojis`               |
| PATCH  | `/api/v1/admin/custom_emojis/:id`           |
| DELETE | `/api/v1/admin/custom_emojis/:id`           |
| GET    | `/api/v1/admin/announcements`               |
| POST   | `/api/v1/admin/announcements`               |
| PUT    | `/api/v1/admin/announcements/:id`           |
| DELETE | `/api/v1/admin/announcements/:id`           |
| POST   | `/api/v1/admin/announcements/:id/publish`   |
| POST   | `/api/v1/admin/announcements/:id/unpublish` |
| GET    | `/api/v1/announcements`                     |
| POST   | `/api/v1/announcements/:id/dismiss`         |
| PUT    | `/api/v1/announcements/:id/reactions/:name` |
| DELETE | `/api/v1/announcements/:id/reactions/:name` |
| GET    | `/.well-known/webfinger`                    |
| GET    | `/.well-known/nodeinfo`                     |
| GET    | `/nodeinfo/2.0`                             |
| POST   | `/api/v1/apps`                              |
| GET    | `/api/v1/apps/verify_credentials`           |
| POST   | `/oauth/token`                              |
| GET    | `/api/v1/accounts/verify_credentials`       |
| PATCH  | `/api/v1/accounts/update_credentials`       |
| GET    | `/api/v1/accounts/lookup`                   |
| GET    | `/api/v1/accounts/relationships`            |
| GET    | `/api/v1/accounts/:id`                      |
| GET    | `/api/v1/accounts/:id/statuses`             |
| GET    | `/api/v1/accounts/:id/followers`            |
| GET    | `/api/v1/accounts/:id/following`            |
| POST   | `/api/v1/accounts/:id/follow`               |
| POST   | `/api/v1/accounts/:id/unfollow`             |
| GET    | `/api/v1/follow_requests`                   |
| POST   | `/api/v1/follow_requests/:id/authorize`     |
| POST   | `/api/v1/follow_requests/:id/reject`        |
| POST   | `/api/v1/accounts/:id/block`                |
| POST   | `/api/v1/accounts/:id/unblock`              |
| POST   | `/api/v1/accounts/:id/mute`                 |
| POST   | `/api/v1/accounts/:id/unmute`               |
| POST   | `/api/v1/accounts/:id/endorse`              |
| POST   | `/api/v1/accounts/:id/unendorse`            |
| GET    | `/api/v1/endorsements`                      |
| GET    | `/api/v1/accounts/:id/endorsements`         |
| POST   | `/api/v1/accounts/:id/note`                 |
| GET    | `/api/v1/blocks`                            |
| GET    | `/api/v1/mutes`                             |
| POST   | `/api/v1/statuses`                          |
| GET    | `/api/v1/statuses/:id`                      |
| DELETE | `/api/v1/statuses/:id`                      |
| PUT    | `/api/v1/statuses/:id`                      |
| PATCH  | `/api/v1/statuses/:id`                      |
| GET    | `/api/v1/statuses/:id/history`              |
| GET    | `/api/v1/statuses/:id/source`               |
| POST   | `/api/v1/statuses/:id/favourite`            |
| POST   | `/api/v1/statuses/:id/unfavourite`          |
| POST   | `/api/v1/statuses/:id/reblog`               |
| POST   | `/api/v1/statuses/:id/unreblog`             |
| POST   | `/api/v1/statuses/:id/bookmark`             |
| POST   | `/api/v1/statuses/:id/unbookmark`           |
| POST   | `/api/v1/statuses/:id/pin`                  |
| POST   | `/api/v1/statuses/:id/unpin`                |
| POST   | `/api/v1/statuses/:id/mute`                 |
| POST   | `/api/v1/statuses/:id/unmute`               |
| GET    | `/api/v1/favourites`                        |
| GET    | `/api/v1/bookmarks`                         |
| GET    | `/api/v1/timelines/public`                  |
| GET    | `/api/v1/timelines/home`                    |
| GET    | `/api/v1/timelines/tag/:hashtag`            |
| POST   | `/api/v1/media`                             |
| POST   | `/api/v2/media`                             |
| GET    | `/media/:id`                                |
| GET    | `/api/v1/notifications`                     |
| GET    | `/api/v1/notifications/unread_count`        |
| POST   | `/api/v1/notifications/clear`               |
| POST   | `/api/v1/notifications/:id/dismiss`         |
| GET    | `/api/v1/polls/:id`                         |
| POST   | `/api/v1/polls/:id/votes`                   |
| GET    | `/api/v1/filters`                           |
| POST   | `/api/v1/filters`                           |
| DELETE | `/api/v1/filters/:id`                       |
| GET    | `/api/v2/filters`                           |
| POST   | `/api/v1/reports`                           |
| GET    | `/api/v1/search`                            |
| GET    | `/api/v2/search`                            |
| GET    | `/api/v1/statuses/:id/context`              |
| GET    | `/api/v1/directory`                         |
| GET    | `/api/v1/instance/peers`                    |
| GET    | `/api/v1/instance/activity`                 |
| GET    | `/api/v1/trends`                            |
| GET    | `/api/v1/trends/tags`                       |
| GET    | `/api/v1/trends/statuses`                   |
| GET    | `/api/v1/trends/links`                      |
| GET    | `/api/v1/suggestions`                       |
| GET    | `/api/v2/suggestions`                       |
| GET    | `/api/v1/tags/:name`                        |
| POST   | `/api/v1/tags/:id/follow`                   |
| POST   | `/api/v1/tags/:id/unfollow`                 |
| POST   | `/api/v1/tags/:id/feature`                  |
| POST   | `/api/v1/tags/:id/unfeature`                |
| GET    | `/api/v1/followed_tags`                     |
| GET    | `/api/v1/featured_tags`                     |
| POST   | `/api/v1/featured_tags`                     |
| DELETE | `/api/v1/featured_tags/:id`                 |
| GET    | `/api/v1/featured_tags/suggestions`         |
| GET    | `/api/v1/accounts/:id/featured_tags`        |
| GET    | `/api/v1/markers`                           |
| POST   | `/api/v1/markers`                           |
| GET    | `/api/v1/conversations`                     |
| POST   | `/api/v1/conversations/:id/read`            |
| GET    | `/api/v1/timelines/direct`                  |
| GET    | `/api/v1/lists`                             |
| POST   | `/api/v1/lists`                             |
| GET    | `/api/v1/lists/:id`                         |
| PUT    | `/api/v1/lists/:id`                         |
| DELETE | `/api/v1/lists/:id`                         |
| GET    | `/api/v1/lists/:id/accounts`                |
| POST   | `/api/v1/lists/:id/accounts`                |
| DELETE | `/api/v1/lists/:id/accounts`                |
| GET    | `/api/v1/accounts/:id/lists`                |
| GET    | `/api/v1/timelines/list/:id`                |
| GET    | `/api/v1/streaming`                         |
| GET    | `/users/:username`                          |
| GET    | `/users/:username/statuses/:id`             |
| GET    | `/users/:username/outbox`                   |
| GET    | `/users/:username/followers`                |
| GET    | `/users/:username/following`                |
| POST   | `/users/:username/inbox`                    |
| POST   | `/inbox`                                    |

Search is D1 `LIKE` over local usernames and status text, plus cached remote actors. With `resolve=true`, a `@user@domain` handle is resolved over WebFinger (or an actor URL fetched directly) and cached before being returned; remote status search is not included. Tag timelines match `#hashtag` in local public notes. A tag document (`/api/v1/tags/:name`) carries a seven-day UTC history derived from public notes; the viewer can follow tags (`/api/v1/tags/:id/follow|unfollow`, `followed_tags`) and feature up to ten of them (`/api/v1/featured_tags`, `.../suggestions`, `POST /api/v1/tags/:id/feature|unfeature`), with `GET /api/v1/accounts/:id/featured_tags` public and featured counts read from the account's public notes. Status create accepts `in_reply_to_id`; context walks ancestors/descendants with visibility filtering. Status authors can edit a note (`PUT`/`PATCH /api/v1/statuses/:id`): each edit snapshots the previous revision into `status_edits`, the status `edited_at` appears once `updated_at != created_at`, `GET /api/v1/statuses/:id/history` returns revisions oldest-first with the current version last, `GET /api/v1/statuses/:id/source` returns the raw text and spoiler, a poll can be re-optioned while it has no votes and has not expired (422 otherwise), and an `Update` activity is delivered to remote followers. Authors can pin up to five non-direct notes (`POST /api/v1/statuses/:id/pin|unpin`, `status_pins`); `GET /api/v1/accounts/:id/statuses?pinned=true` returns them, and that collection also honors `exclude_replies`, `exclude_reblogs`, `only_media`, `tagged`, and `max_id`. A conversation mute (`POST /api/v1/statuses/:id/mute|unmute`) stores the thread root in `status_mutes`, marks every note in the thread `muted`, and hides the thread from the viewer's home, list, and direct timelines and from notifications that reference it; thread roots are resolved by walking `in_reply_to_id`. Directory lists local accounts. Peers are distinct `remote_actors.domain` values. Activity aggregates weekly local status and registration counts. Trends tags/statuses are derived from recent public local notes. Suggestions (`/api/v1/suggestions`, `/api/v2/suggestions`) are directory accounts the viewer has not followed, blocked, or muted; `/api/v1/trends/links` ranks link cards extracted from recent public notes. Instance rules are read from the `INSTANCE_RULES` var. Custom emojis are read from the `CUSTOM_EMOJIS` var plus admin-managed rows; both surface on account/status/poll documents as the `emojis` array whenever their `:shortcode:` appears (inline `<img>` rendering inside `content` is not done). Admins (`requireAdmin`) manage rows under `/api/v1/admin/custom_emojis` (`GET`, `POST` multipart `shortcode` + `image`, `PATCH` `visible_in_picker`/`category` and optional replacement `image`, `DELETE`), with images stored in the media bucket under `emoji/`; a DB shortcode shadows a config one. Announcements come from the `ANNOUNCEMENTS` var plus runtime-authored rows (`announcements`, `migration 0021`) that admins manage under `/api/v1/admin/announcements` (`GET`/`POST`/`PUT`/`DELETE`, plus `POST /:id/publish|unpublish`); a stored announcement is public only while `published_at` is set and within `starts_at`/`ends_at`, and admin `text` is HTML-escaped and wrapped in a paragraph. Announcements are filtered to those live for the viewer; dismissals and reactions are per-viewer rows in `account_announcement_dismissals` / `account_announcement_reactions` (`migration 0015`), a reaction is accepted only when the announcement declares it or it is a configured custom emoji, and the announcement list requires authentication. Direct visibility is limited to the author and locally mentioned accounts (`status_mentions`); conversations group Direct threads by root status id; markers persist home/notifications read positions. Lists are per-account named member sets with optional `replies_policy` and a dedicated list timeline. Inbox accepts signed Follow / Undo / Like / Announce / Create that target this instance. Local actors verify against the stored account key. Remote actors verify against a cached `RemoteActor` public key, fetching and persisting the actor document from `keyId` on a cache miss. Remote `Create` / `Announce` Notes are stored as `RemoteStatus` and appear on the public timeline. Remote Like / Announce of a local status increment that status's favourite and reblog counts. `GET /api/v1/streaming` is a Durable Object WebSocket hub with write-time fan-out for updates and notifications.

Locked accounts collect pending follow requests from local followers (`follows.kind = 'Pending'`) and remote followers (`remote_follows.remote_request_kind = 'Queued'`). `GET /api/v1/follow_requests` lists both as account documents, most recent first. `POST /api/v1/follow_requests/:id/authorize` promotes the request to `Accepted`; for a remote follower it also delivers a signed `Accept` that references the original Follow activity to the follower's inbox. `POST /api/v1/follow_requests/:id/reject` deletes the pending request and, for a remote follower, delivers a signed `Reject`. Both endpoints return the requester `Relationship`; an unknown or non-pending id is `NotFound`.

Blocks and mutes are stored per viewer keyed by the target actor URI (`blocks`, `mutes`; `migration 0011`), with the local target account id recorded for local targets. `POST /api/v1/accounts/:id/block|unblock` and `.../mute|unmute` return the viewer `Relationship`; `mute` accepts `notifications` (default true) and `duration` seconds (0 or absent = no expiry). Blocks and active mutes hide the target's notes from the viewer's home, list, and direct timelines, and — as in Mastodon — a block also hides the viewer's notes from the blocked account (the `blocked_by` direction). Notifications exclude senders the viewer blocks and senders the viewer muted with `notifications`; a mute with `notifications=false` still hides the timeline but keeps notifications. A mute expires when `expires_at` passes. Unlike cfwdon, tstodon applies the block to these timelines (cfwdon filters only mutes) and leaves public/tag timelines unfiltered. `GET /api/v1/blocks` and `GET /api/v1/mutes` list the viewer's targets as account documents. Endorsements (featured accounts) store a local account id or a remote actor URI in `endorsements` (`migration 0019`); `POST /api/v1/accounts/:id/endorse|unendorse` returns the viewer `Relationship` with `endorsed`, and `GET /api/v1/endorsements` plus the public `GET /api/v1/accounts/:id/endorsements` list them as account documents. Lists carry an `exclusive` flag accepted on create and update. `POST /api/v1/accounts/:id/note` stores a private note about a target (`account_notes`, `migration 0020`), returned as `Relationship.note` only to its author; a blank comment clears it. Notifications honor per-account actions: `POST /api/v1/notifications/:id/dismiss` records a dismissal, `POST /api/v1/notifications/clear` moves a clear marker, and `GET /api/v1/notifications/unread_count` counts visible notifications newer than the notifications marker (excluding cleared, dismissed, blocked, and notification-muted senders).

### Placeholder

None: every route listed above is implemented.

`OutboxDeliveryWorkflow` retries signed inbox POSTs per remote target. Cron enqueues `ProcessExpiredPolls`, which marks expired polls and pushes `status.update` onto the author's `StreamHub`. Status creates and notifications also publish onto per-account hubs.

### Out of scope

<!-- derived-from #principles -->

- Workers AI / Vectorize search
- Mastodon admin APIs beyond custom emojis and announcements
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

<!-- derived-from ../reference/configuration.md#local-development-authentication -->
<!-- constrained-by ../reference/configuration.md#cloudflare-access-authentication-vars -->
<!-- dagayn: implemented-by packages/worker/src/auth.ts::authenticate -->

Protected API routes accept a Cloudflare Access JWT via `Cf-Access-Jwt-Assertion` or `Authorization: Bearer <Access JWT>`. Local tests mint Access-shaped JWTs with `packages/worker/test/access-jwt-fixture.ts` (admin via the configured Access group claim). Production verifies against the Access JWKS using `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`. Role is `{ kind: "Admin" }` when JWT groups intersect `CF_ACCESS_ADMIN_GROUPS`, otherwise `{ kind: "User" }`. The Worker provisions a local account from the `email` claim. WorkOS is the Access IdP in Zero Trust only. `GET /login` explains Access sign-in. `requireAdmin` maps non-admin sessions to `kind: Forbidden`.

## Federation

<!-- constrained-by ../architecture/tstodon-architecture.md#http-routing -->

Public discovery and actor documents are unauthenticated. Inbox requests must carry a draft-cavage `Signature` (and matching `Digest`). Verification uses the local actor key when `actor` is on this instance, otherwise a cached remote actor key (fetched from `keyId` on miss). Missing, unverifiable, or blocked actor keys return `kind: InvalidSignature`. Unreachable key fetches return `kind: VerificationUnavailable`.

Outbound Create / Announce jobs enqueue `ExpandFollowers` on `OUTBOX_PROCESS_QUEUE`. The queue inserts a `Queued` `outbox_deliveries` row per remote inbox and starts `OutboxDeliveryWorkflow`. The workflow signs POSTs, maps HTTP status onto `DeliveryAttemptOutcome`, and applies `OutboxDelivery.afterAttempt` with `workflowSleep` between transient failures. Same-host inboxes are skipped. Inbound Create / Announce persist a `RemoteStatus` when the object is a Note attributed to the signing actor. Remote Like / Announce of a local status are stored separately from local account rows and counted on that status. Nested Undo of Like or Announce removes the remote row.

Remote accounts are exposed to the Mastodon API under a path-safe id: `r_` + base64url(actor URI) (`RemoteAccountId`). `GET /api/v1/accounts/:id` and the follow request authorize/reject endpoints decode it back to the actor URI, so remote targets no longer need percent-encoding in path segments.

## Next

<!-- derived-from #out-of-scope -->

- Defer Vectorize / Workers AI until local search cost is acceptable (still out of scope).
