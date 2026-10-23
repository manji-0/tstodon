# Open TODOs (post D1 design catch-up)

<!-- constrained-by ../architecture/d1-heavy-scenarios.md -->
<!-- constrained-by ../architecture/d1-write-strategy.md -->

Tracked leftovers so e2e work can proceed without losing them.

## D1 / heavy scenarios (deferred)

| ID   | Item                                                   | Notes                                                  |
| ---- | ------------------------------------------------------ | ------------------------------------------------------ |
| D1-1 | Fan-out / expand-CPU SLO for secondary queue chunking  | Open Question — needs `outbox.expand` metrics evidence |
| D1-2 | Hard API max on list member mutation size              | Open Question — do not invent a number                 |
| D1-3 | Promote hashtag rows / FTS                             | After search/`timeline.tag` p95 evidence (Doc B PR6)   |
| D1-4 | Timeline preload: `Promise.all` vs single `runD1Batch` | Defer until metrics show a success criterion           |
| D1-5 | Hot-key Durable Object for write serialization         | Only with evidence beyond D1 primary                   |

## Web Push (open)

| ID   | Item                    | Notes                                                                                |
| ---- | ----------------------- | ------------------------------------------------------------------------------------ |
| WP-2 | Per-token subscriptions | Blocked on token identity: Access JWTs carry none, so subscriptions are per endpoint |

## Direct messages (open)

| ID   | Item                                 | Notes                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM-4 | Conversation mutes on remote replies | `status_mutes` hides local thread members only; a remote reply into a muted thread still shows                                                                                                                                                              |
| DM-8 | Context paging after filtering       | `/context` caps each level before the visibility and block filters, so a count-limited thread can come back short. Mastodon does the same (`ancestor_ids(limit)` / `descendant_ids(limit, depth)` before filtering), so this stays unless parity is dropped |

## Done recently (do not re-open)

- Remote statuses render `in_reply_to_id` / `in_reply_to_account_id` from their stored `inReplyTo`

- Thread context spans local and cached remote statuses (either id; remote replies to local notes included)

- Local notes reply to cached remote statuses (`statuses.in_reply_to_uri`): rendered parent, `inReplyTo` on every federated note, direct replies grouped into the remote conversation

- Local notes mention remote accounts (`@user@domain`): Mention tags, Mastodon addressing, delivery by addressing (direct notes to mentioned inboxes only), `mentions` rendered

- Remote direct notes reach the addressed account's direct timeline and conversations (`remote_status_mentions`, replies grouped by `inReplyTo`), and open for it on `GET /api/v1/statuses/:id`

- Remote Follow/Like/Announce and mentions in new remote notes notify the local target (`r_…` senders, deduplicated, block/mute/domain-block aware); remote accounts can be blocked and muted

- Web Push: subscriptions per account + endpoint, VAPID key advertised, notifications delivered (`aes128gcm`/`aesgcm`, VAPID ES256)

- Toolchain on Vite+ (`vp check`/`test`/`dev`/`build`, Vitest 5 via `@cloudflare/vitest-plugin`, Worker built by Void (`voidPlugin()`, wrapping `@cloudflare/vite-plugin`))
- `FEDERATION_ALLOW_HOSTS` matches `host:port` peers by hostname (inbox gate and follower fan-out)
- Link-card test no longer asserts an empty card right after posting (queue race)
- `GET /api/v1/accounts?id[]=` and `GET /api/v1/statuses?id[]=` batch lookups
- `DELETE /api/v1/profile/avatar` and `/header`
- Quote notifications (`quote`, `quoted_update`)
- `source[sensitive]`/`source[language]` defaults applied to new posts
- Outbound quote in the ActivityPub Note (`quote`/`quote_uri`/`_misskey_quote`)
- `indexable`/`hide_collections`/`noindex` and hidden follower collections
- Credential `source` (privacy/quote_policy defaults) and `update_credentials` support
- Quote posts (`quoted_status_id`, policy, quotes list, revoke, document fields)
- `favourited_by`/`reblogged_by` pagination on engagement row ids
- `Link` pagination headers on notifications, favourites, and bookmarks
- Follower/following pagination by follow row id with `Link` headers
- Stable notification-request ids (`notification_request_groups`) and id cursors
- Runtime `domain_allows` admin API and enforced limited federation
- Trend review records and admin approve/reject for tags, links, and statuses
- Row ids + `Link` pagination for blocks, mutes, endorsements, follow requests
- Scheduled statuses (create via `scheduled_at`, CRUD, cron publish)
- `GET /api/v1/preferences`
- Follow options: `reblogs`, `notify`, `languages[]` (and the relationship fields)
- `GET /api/v1/media/:id` and `DELETE /api/v1/conversations/:id`
- Remote tags indexed (`remote_status_tags`) with a cron backfill; exact tag paging
- `include_filtered` on the v1 and grouped v2 notification lists
- Canonical email + email domain blocks (enforced at sign-up)
- `GET /api/v1/admin/accounts/:id`
- `/action` resolves the named report (or all open reports for the account)
- Report `PUT` (category/rules), `assign_to_self`/`unassign`, `rule_ids` on create
- Admin reports list/single/resolve/reopen + report `category`
- Tag and public timelines honor `local`/`remote`; tag timelines include remote statuses
- `POST /admin/accounts/:id/action` + a real `disabled` state (`/enable` restores login only)
- Admin account/domain-block lists page by `max_id`/`since_id`/`min_id`
- Link-preview TTL test asserts the served title, not fetch counts (queue-flake free)
- `GET /api/v1/accounts/search` (exact handle, `offset`, `following`, resolve 503)
- `REGISTRATION_APPROVAL`, `approve`/`reject`, `approved` field, admin account filters
- `limit` caps match Mastodon per collection family (40 / 80 / 200); endorsements page
- `notifications/requests` accepts `limit` (40 default, 80 cap)
- Link-card test fetch stubs are host-scoped (no cross-file flake)
- Tag timeline accepts `any[]`/`all[]`/`none[]` (4-tag cap) and `only_media`
- Reblog honours `visibility`, refuses non-rebloggable statuses, and is idempotent
- `favourited_by` / `reblogged_by` list local and remote accounts behind a status's counts
- Poll edit accepts `hide_totals`
- `filter_action` is client-applied and unknown actions read as `warn` (documented + tested)
- `trends/links` supports `limit` + `offset` paging
- Link timeline (`/api/v1/timelines/link?url=`) for trending links
- Cron `RefreshLinkCards` job refreshes aged previews (20 per run)
- Single notification reports `filtered` like the list
- Link previews refresh after a week in the cache
- `ProcessLinkCard` retries transient failures (3 attempts) and reports `outbox.job` metrics
- `notification_requests.status_id` for an exact request `last_status`
- Trending links prefer the cached Open Graph preview
- `filtered` on remote statuses (HTML stripped to text for keyword matching)
- `notifications_merged` stream event when requests are accepted
- Notification cursors: `since_id` / `min_id` on the v1 and grouped v2 lists
- Link previews run off the request path (`ProcessLinkCard` queue job) and cover remote statuses
- `filtered` on the home/list/direct/public/tag/account-status timelines
- Link previews: bounded Open Graph unfurl cached in `link_cards`, stored on the status
- Profile fields capped at four
- Profile images (`avatar`/`header` uploads) and the `locked` toggle
- Notification policy + requests with `drop`/`filter`/`accept`, and `api_versions: {mastodon: 2}`
- Media uploads validate the advertised `supported_mime_types`
- Account profiles: bio (`note`), fields, bot/discoverable in every account document
- `GET /api/v1/notifications/:id`
- `filtered` attribute on search results and notifications (keyword + narrowed-status matching)
- Filter narrowing: `/api/v2/filters/:id/statuses` + `statuses` on the v2 document
- v2 filter verbs plus keyword sub-resources (`filters.keywords_json`)
- Filter paths and entities match Mastodon: flat `filters/keywords/:id` and `filters/statuses/:id`, FilterStatus `{id, status_id}`, v1 `GET`/`PUT /api/v1/filters/:id`
- Grouped notifications (`/api/v2/notifications` + group_key endpoints and unread count)
- Poll `hide_totals` (counts null until expiry) and a vote now answers the Poll entity
- `reject_media` enforced: remote attachments dropped on persist and cleared for existing rows
- Remote status attachments captured from ActivityPub and rendered (`remote_statuses.media_json`)
- `DELETE /api/v1/statuses/:id` returns the raw `text` for delete-and-redraft
- `Idempotency-Key` on POST /api/v1/statuses (`status_idempotency`, one hour, per account)
- `instance/peers` and `instance/activity` require a user token under limited federation
- `/api/v2/instance`: registrations detail, thumbnail description, policy URLs (icon and `api_versions` intentionally omitted)
- Instance policy documents from JSON vars (extended description, privacy policy, terms of service by date)
- Status translate endpoint (403 ineligible, 503 without a backend) and empty `translation_languages`
- Enforced post limits from `InstanceLimits` (text/CW 500, media 4, poll 2-4 x 50 chars, expiry 5 min-1 month, description 1500) reflected in `/api/v2/instance`
- Public `GET /api/v1/instance/domain_blocks` (digest / obfuscate / public comment) and Monday-aligned `instance/activity`
- Trends tags carry the real seven-day history (shared with `/tags/:name`); search hashtags too
- Admin account sensitize/unsensitize (forces `sensitive`) and `DELETE /api/v1/admin/accounts/:id` purge
- Admin domain blocks: `/api/v1/admin/domain_blocks` CRUD (silence/suspend/noop) with fetch, inbox, outbound, and public-timeline enforcement
- Per-viewer domain blocks: `GET`/`POST`/`DELETE /api/v1/domain_blocks`, `Relationship.domain_blocking`, public timeline filtering
- `media_attributes` on status create/edit (JSON array or bracket form fields)
- Status context bounds: anonymous 40/60 depth 20 vs authenticated 4096, descendants in id order
- Admin accounts: `GET /api/v1/admin/accounts` + silence/suspend/enable, 403/410 and public-surface exclusion
- Media metadata: `PUT` / `DELETE /api/v1/media/:id` (alt text, focus, unattached-only)
- Remove from followers: `POST /api/v1/accounts/:id/remove_from_followers` (local + remote Reject)
- Timeline cursors: `max_id` / `since_id` / `min_id` on home, public, tag, bookmarks, favourites, account statuses
- Familiar followers: `GET /api/v1/accounts/familiar_followers?id[]=`
- Notification filters: `types[]` / `exclude_types[]` / `account_id` / `max_id`
- Admin announcements: `/api/v1/admin/announcements` CRUD + publish/unpublish, merged with `ANNOUNCEMENTS`
- Account notes: `POST /api/v1/accounts/:id/note` + `Relationship.note` (private per viewer)
- Endorsements (featured accounts) + list `exclusive`
- Account status filters: `exclude_replies` / `exclude_reblogs` / `only_media` / `tagged` / `max_id`; reblog now returns the reblog document
- Poll editing: re-option an unvoted, unexpired poll via `PUT /api/v1/statuses/:id`
- Admin custom emojis: `/api/v1/admin/custom_emojis` CRUD (bucket `emoji/` + `custom_emojis`), merged with `CUSTOM_EMOJIS`
- Tag actions: follow/unfollow, tag documents with 7-day history, featured tags (10 cap) + suggestions
- Conversation mutes: `status_mutes` by thread root, `muted` flag, timeline/notification suppression
- Custom emojis (`CUSTOM_EMOJIS`) and announcements (`ANNOUNCEMENTS`) replace the last placeholder routes
- Remote search: cached remote actors + `resolve=true` WebFinger/actor resolution
- Pinned statuses: pin/unpin, five-pin limit, `?pinned=true` account statuses
- Status edit: PUT/PATCH `/statuses/:id`, `/history`, `/source`, `status_edits` snapshots, `edited_at`, Update activity
- Instance rules served from `INSTANCE_RULES` (v1 rules endpoint + v2 instance)
- Suggestions (v1/v2, with per-viewer dismissal) and trends/links derived from local accounts and public notes
- Notifications: clear, dismiss, unread_count (marker-aware, honoring blocks/mutes)
- Path-safe remote account ids: `r_` + base64url actor URI; accounts/:id and follow request targets decode it
- Blocks + mutes: endpoints, relationship flags, home/list/direct timeline suppression, notification gating; `d1PrepareTyped` expands repeated `$N`
- Follow requests: list/authorize/reject for local + remote pending, Accept/Reject delivery, `remote_follows.follow_activity_id`
- json_each membership; TypedSQL fixed SQL; wrangler migrations SoT ADRs
- `runTypedBatch`; ExpandFollowers remote-only + chunked targets
- Create saga mentions-before-notify; `enqueueLocalActivity` Result
- Expired-poll bulk `mastodonStatuses`
- Analytics indexes: `outbox.expand`, `outbox.enqueue`, `search`, `timeline.tag`
- WP-1: notifications are pushed to Web Push subscriptions (`DeliverPush` queue job, RFC 8291/8292)
- DM-5: deleting a local note federates a `Delete` with a `Tombstone`, addressed like the note
- DM-7: the AP outbox filters to public Creates and Announces in SQL, before its `LIMIT`; boosts federate a Mastodon-shaped `Announce` (`id`, `published`, visibility-based `to`/`cc`, the note's own URI) and unreblog federates its `Undo`
- Query indexes (`0065_query_indexes.sql`): boost/favourite counts, favourited_by/reblogged_by, thread descendants, status media, status-delete cascades, the outbox, delivery fan-out rows, remote-actor handles, and per-account cascades no longer scan their tables
- DM-6: followers-only and direct notes answer a signed fetch (authorized fetch) from an actor they address, or from an accepted follower when they address followers, with `Cache-Control: private`
- HTTP signatures verify every signed header with its real value; signatures that also cover `content-type` or `accept` (as Mastodon's do) used to fail
- Batched account documents on account lists (followers, following, follow requests, endorsements, list members, favourited/reblogged by, search, familiar followers), remote actors on timelines, notification requests, and tag histories (one status scan for every tag on a page)

## Active track

| ID    | Item                                                           | Status |
| ----- | -------------------------------------------------------------- | ------ |
| E2E-1 | process-compose multi-instance harness                         | done   |
| E2E-2 | Minimal 2-instance federation (WebFinger + Follow→Create)      | done   |
| E2E-3 | Undo/Like/Announce (+ Undo Like) e2e                           | done   |
| E2E-6 | Accept round-trip after remote Follow                          | done   |
| E2E-5 | Delete + shared-inbox-only fan-out e2e                         | done   |
| E2E-4 | Prefer worker-delivered Create/Accept (host hop fallback only) | done   |
