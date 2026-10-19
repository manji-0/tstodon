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

| Method | Path                                         |
| ------ | -------------------------------------------- |
| GET    | `/healthz`                                   |
| GET    | `/login`                                     |
| GET    | `/api/v1/instance`                           |
| GET    | `/api/v1/instance/rules`                     |
| GET    | `/api/v1/instance/domain_blocks`             |
| GET    | `/api/v1/instance/translation_languages`     |
| GET    | `/api/v1/instance/extended_description`      |
| GET    | `/api/v1/instance/privacy_policy`            |
| GET    | `/api/v1/instance/terms_of_service`          |
| GET    | `/api/v1/instance/terms_of_service/:date`    |
| GET    | `/api/v2/instance`                           |
| GET    | `/api/v1/custom_emojis`                      |
| GET    | `/api/v1/admin/custom_emojis`                |
| POST   | `/api/v1/admin/custom_emojis`                |
| PATCH  | `/api/v1/admin/custom_emojis/:id`            |
| DELETE | `/api/v1/admin/custom_emojis/:id`            |
| GET    | `/api/v1/admin/announcements`                |
| POST   | `/api/v1/admin/announcements`                |
| PUT    | `/api/v1/admin/announcements/:id`            |
| DELETE | `/api/v1/admin/announcements/:id`            |
| POST   | `/api/v1/admin/announcements/:id/publish`    |
| POST   | `/api/v1/admin/announcements/:id/unpublish`  |
| GET    | `/api/v1/admin/accounts`                     |
| POST   | `/api/v1/admin/accounts/:id/silence`         |
| POST   | `/api/v1/admin/accounts/:id/unsilence`       |
| POST   | `/api/v1/admin/accounts/:id/suspend`         |
| POST   | `/api/v1/admin/accounts/:id/unsuspend`       |
| POST   | `/api/v1/admin/accounts/:id/enable`          |
| POST   | `/api/v1/admin/accounts/:id/sensitize`       |
| POST   | `/api/v1/admin/accounts/:id/unsensitize`     |
| DELETE | `/api/v1/admin/accounts/:id`                 |
| GET    | `/api/v1/admin/domain_blocks`                |
| GET    | `/api/v1/admin/domain_blocks/:id`            |
| POST   | `/api/v1/admin/domain_blocks`                |
| PUT    | `/api/v1/admin/domain_blocks/:id`            |
| DELETE | `/api/v1/admin/domain_blocks/:id`            |
| GET    | `/api/v1/announcements`                      |
| POST   | `/api/v1/announcements/:id/dismiss`          |
| PUT    | `/api/v1/announcements/:id/reactions/:name`  |
| DELETE | `/api/v1/announcements/:id/reactions/:name`  |
| GET    | `/.well-known/webfinger`                     |
| GET    | `/.well-known/nodeinfo`                      |
| GET    | `/nodeinfo/2.0`                              |
| POST   | `/api/v1/apps`                               |
| GET    | `/api/v1/apps/verify_credentials`            |
| POST   | `/oauth/token`                               |
| GET    | `/api/v1/accounts/verify_credentials`        |
| PATCH  | `/api/v1/accounts/update_credentials`        |
| GET    | `/api/v1/accounts/lookup`                    |
| GET    | `/api/v1/accounts/relationships`             |
| GET    | `/api/v1/accounts/familiar_followers`        |
| GET    | `/api/v1/accounts/:id`                       |
| GET    | `/api/v1/accounts/:id/statuses`              |
| GET    | `/api/v1/accounts/:id/followers`             |
| GET    | `/api/v1/accounts/:id/following`             |
| POST   | `/api/v1/accounts/:id/follow`                |
| POST   | `/api/v1/accounts/:id/unfollow`              |
| POST   | `/api/v1/accounts/:id/remove_from_followers` |
| GET    | `/api/v1/follow_requests`                    |
| POST   | `/api/v1/follow_requests/:id/authorize`      |
| POST   | `/api/v1/follow_requests/:id/reject`         |
| POST   | `/api/v1/accounts/:id/block`                 |
| POST   | `/api/v1/accounts/:id/unblock`               |
| POST   | `/api/v1/accounts/:id/mute`                  |
| POST   | `/api/v1/accounts/:id/unmute`                |
| POST   | `/api/v1/accounts/:id/endorse`               |
| POST   | `/api/v1/accounts/:id/unendorse`             |
| GET    | `/api/v1/endorsements`                       |
| GET    | `/api/v1/accounts/:id/endorsements`          |
| POST   | `/api/v1/accounts/:id/note`                  |
| GET    | `/api/v1/blocks`                             |
| GET    | `/api/v1/mutes`                              |
| GET    | `/api/v1/domain_blocks`                      |
| POST   | `/api/v1/domain_blocks`                      |
| DELETE | `/api/v1/domain_blocks`                      |
| POST   | `/api/v1/statuses`                           |
| GET    | `/api/v1/statuses/:id`                       |
| DELETE | `/api/v1/statuses/:id`                       |
| PUT    | `/api/v1/statuses/:id`                       |
| PATCH  | `/api/v1/statuses/:id`                       |
| GET    | `/api/v1/statuses/:id/history`               |
| GET    | `/api/v1/statuses/:id/source`                |
| POST   | `/api/v1/statuses/:id/favourite`             |
| POST   | `/api/v1/statuses/:id/unfavourite`           |
| POST   | `/api/v1/statuses/:id/reblog`                |
| POST   | `/api/v1/statuses/:id/unreblog`              |
| POST   | `/api/v1/statuses/:id/bookmark`              |
| POST   | `/api/v1/statuses/:id/unbookmark`            |
| POST   | `/api/v1/statuses/:id/pin`                   |
| POST   | `/api/v1/statuses/:id/unpin`                 |
| POST   | `/api/v1/statuses/:id/mute`                  |
| POST   | `/api/v1/statuses/:id/unmute`                |
| POST   | `/api/v1/statuses/:id/translate`             |
| GET    | `/api/v1/favourites`                         |
| GET    | `/api/v1/bookmarks`                          |
| GET    | `/api/v1/timelines/public`                   |
| GET    | `/api/v1/timelines/home`                     |
| GET    | `/api/v1/timelines/tag/:hashtag`             |
| POST   | `/api/v1/media`                              |
| POST   | `/api/v2/media`                              |
| PUT    | `/api/v1/media/:id`                          |
| DELETE | `/api/v1/media/:id`                          |
| GET    | `/media/:id`                                 |
| GET    | `/api/v1/notifications`                      |
| GET    | `/api/v1/notifications/unread_count`         |
| GET    | `/api/v1/notifications/:id`                  |
| GET    | `/api/v2/notifications/policy`               |
| PATCH  | `/api/v2/notifications/policy`               |
| GET    | `/api/v1/notifications/requests`             |
| GET    | `/api/v1/notifications/requests/:id`         |
| GET    | `/api/v1/notifications/requests/merged`      |
| POST   | `/api/v1/notifications/requests/:id/accept`  |
| POST   | `/api/v1/notifications/requests/:id/dismiss` |
| POST   | `/api/v1/notifications/requests/accept`      |
| POST   | `/api/v1/notifications/requests/dismiss`     |
| GET    | `/api/v2/notifications`                      |
| GET    | `/api/v2/notifications/unread_count`         |
| GET    | `/api/v2/notifications/:group_key`           |
| GET    | `/api/v2/notifications/:group_key/accounts`  |
| POST   | `/api/v2/notifications/:group_key/dismiss`   |
| POST   | `/api/v2/filters`                            |
| GET    | `/api/v2/filters/:id`                        |
| PUT    | `/api/v2/filters/:id`                        |
| DELETE | `/api/v2/filters/:id`                        |
| GET    | `/api/v2/filters/:id/keywords`               |
| POST   | `/api/v2/filters/:id/keywords`               |
| PUT    | `/api/v2/filters/:id/keywords/:keyword_id`   |
| GET    | `/api/v2/filters/:id/statuses`               |
| POST   | `/api/v2/filters/:id/statuses`               |
| DELETE | `/api/v2/filters/:id/statuses/:status_id`    |
| DELETE | `/api/v2/filters/:id/keywords/:keyword_id`   |
| GET    | `/api/v2/filters/:id/statuses`               |
| POST   | `/api/v2/filters/:id/statuses`               |
| DELETE | `/api/v2/filters/:id/statuses/:status_id`    |
| POST   | `/api/v1/notifications/clear`                |
| POST   | `/api/v1/notifications/:id/dismiss`          |
| GET    | `/api/v1/polls/:id`                          |
| POST   | `/api/v1/polls/:id/votes`                    |
| GET    | `/api/v1/filters`                            |
| POST   | `/api/v1/filters`                            |
| DELETE | `/api/v1/filters/:id`                        |
| GET    | `/api/v2/filters`                            |
| POST   | `/api/v1/reports`                            |
| GET    | `/api/v1/search`                             |
| GET    | `/api/v2/search`                             |
| GET    | `/api/v1/statuses/:id/context`               |
| GET    | `/api/v1/directory`                          |
| GET    | `/api/v1/instance/peers`                     |
| GET    | `/api/v1/instance/activity`                  |
| GET    | `/api/v1/trends`                             |
| GET    | `/api/v1/trends/tags`                        |
| GET    | `/api/v1/trends/statuses`                    |
| GET    | `/api/v1/trends/links`                       |
| GET    | `/api/v1/suggestions`                        |
| GET    | `/api/v2/suggestions`                        |
| GET    | `/api/v1/tags/:name`                         |
| POST   | `/api/v1/tags/:id/follow`                    |
| POST   | `/api/v1/tags/:id/unfollow`                  |
| POST   | `/api/v1/tags/:id/feature`                   |
| POST   | `/api/v1/tags/:id/unfeature`                 |
| GET    | `/api/v1/followed_tags`                      |
| GET    | `/api/v1/featured_tags`                      |
| POST   | `/api/v1/featured_tags`                      |
| DELETE | `/api/v1/featured_tags/:id`                  |
| GET    | `/api/v1/featured_tags/suggestions`          |
| GET    | `/api/v1/accounts/:id/featured_tags`         |
| GET    | `/api/v1/markers`                            |
| POST   | `/api/v1/markers`                            |
| GET    | `/api/v1/conversations`                      |
| POST   | `/api/v1/conversations/:id/read`             |
| GET    | `/api/v1/timelines/direct`                   |
| GET    | `/api/v1/lists`                              |
| POST   | `/api/v1/lists`                              |
| GET    | `/api/v1/lists/:id`                          |
| PUT    | `/api/v1/lists/:id`                          |
| DELETE | `/api/v1/lists/:id`                          |
| GET    | `/api/v1/lists/:id/accounts`                 |
| POST   | `/api/v1/lists/:id/accounts`                 |
| DELETE | `/api/v1/lists/:id/accounts`                 |
| GET    | `/api/v1/accounts/:id/lists`                 |
| GET    | `/api/v1/timelines/list/:id`                 |
| GET    | `/api/v1/streaming`                          |
| GET    | `/users/:username`                           |
| GET    | `/users/:username/statuses/:id`              |
| GET    | `/users/:username/outbox`                    |
| GET    | `/users/:username/followers`                 |
| GET    | `/users/:username/following`                 |
| POST   | `/users/:username/inbox`                     |
| POST   | `/inbox`                                     |

Search is D1 `LIKE` over local usernames and status text, plus cached remote actors. With `resolve=true`, a `@user@domain` handle is resolved over WebFinger (or an actor URL fetched directly) and cached before being returned; remote status search is not included. Tag timelines match `#hashtag` in local public notes. Home, public, tag, bookmarks, favourites, and account status collections accept `max_id`, `since_id`, and `min_id` (Mastodon semantics: `max_id` pages older, `since_id` newer newest-first, `min_id` newer oldest-first). A tag document (`/api/v1/tags/:name`) carries a seven-day UTC history derived from public notes; the viewer can follow tags (`/api/v1/tags/:id/follow|unfollow`, `followed_tags`) and feature up to ten of them (`/api/v1/featured_tags`, `.../suggestions`, `POST /api/v1/tags/:id/feature|unfeature`), with `GET /api/v1/accounts/:id/featured_tags` public and featured counts read from the account's public notes. Status create accepts `in_reply_to_id` and honors the `Idempotency-Key` header (keys map to the created status for an hour per account, so a retry returns the same status; an in-flight key answers 409 and a failed create releases the key); context walks ancestors/descendants with visibility filtering under Mastodon's bounds (anonymous: 40 ancestors / 60 descendants at depth 20; authenticated: up to 4096 of each), returning descendants in id order. Status authors can edit a note (`PUT`/`PATCH /api/v1/statuses/:id`): each edit snapshots the previous revision into `status_edits`, the status `edited_at` appears once `updated_at != created_at`, `GET /api/v1/statuses/:id/history` returns revisions oldest-first with the current version last, `GET /api/v1/statuses/:id/source` returns the raw text and spoiler, a poll can be re-optioned (and its `hide_totals` switched, either way, with the setting kept when the edit omits it) while it has no votes and has not expired (422 otherwise), the delete response carries the raw `text` (with `media_attachments` and `poll`) for delete-and-redraft, and an `Update` activity is delivered to remote followers. Authors can pin up to five non-direct notes (`POST /api/v1/statuses/:id/pin|unpin`, `status_pins`); `GET /api/v1/accounts/:id/statuses?pinned=true` returns them, and that collection also honors `exclude_replies`, `exclude_reblogs`, `only_media`, `tagged`, and `max_id`. A conversation mute (`POST /api/v1/statuses/:id/mute|unmute`) stores the thread root in `status_mutes`, marks every note in the thread `muted`, and hides the thread from the viewer's home, list, and direct timelines and from notifications that reference it; thread roots are resolved by walking `in_reply_to_id`. Polls accept `poll[hide_totals]`: while such a poll has not expired, `votes_count`, `voters_count`, and every option's `votes_count` are null (own votes stay visible); single-choice polls report `voters_count: null` either way, and `POST /api/v1/polls/:id/votes` answers the updated Poll entity. Post limits live in one place (`InstanceLimits` in `@tstodon/core`) and are enforced, not just advertised: 500 characters of text or content warning, up to four media attachments, polls of two to four options of at most 50 characters with the expiry clamped to 5 minutes - 1 month, and media descriptions of at most 1500 characters. `/api/v2/instance` reports the same numbers plus `translation.enabled: false` and `limited_federation` when `FEDERATION_ALLOW_HOSTS` is set. Media uploads are accepted only when the file declares one of the advertised `supported_mime_types` (otherwise 422 `UnsupportedMediaType`), and that list is read from `InstanceLimits`. The instance policy documents are config-driven JSON vars (`INSTANCE_EXTENDED_DESCRIPTION` and `INSTANCE_PRIVACY_POLICY` as `{ content, updated_at? }`, `INSTANCE_TERMS_OF_SERVICE` as `{ content, effective_date }`), each answering 404 when unset; `GET /api/v1/instance/terms_of_service/:date` matches the configured effective date. No translation backend is configured: `POST /api/v1/statuses/:id/translate` answers 403 for followers-only or direct statuses and 503 Service Unavailable otherwise, and `GET /api/v1/instance/translation_languages` is an empty object. `PATCH /api/v1/accounts/update_credentials` also stores the bio, profile fields, and the `bot`/`discoverable` flags (`account_profiles`, `migration 0032`), which every account document reports (`note` is the escaped paragraph form of the bio, `fields` drop blank entries and keep at most four (`InstanceLimits.account.maxProfileFields`), omitted fields keep their previous value); multipart `avatar`/`header` uploads are stored in the media bucket under `avatars/` and `headers/` (image types only, up to 5 MB) and reported as the account's `avatar`/`header`, and `locked` switches the account to manual follower approval (`setAccountLocked`). Directory lists local accounts. Peers are distinct `remote_actors.domain` values. Under limited federation (a non-empty `FEDERATION_ALLOW_HOSTS`) `GET /api/v1/instance/peers` and `/api/v1/instance/activity` require a user token, as in Mastodon. Activity aggregates weekly local status and registration counts. Trends tags/statuses are derived from recent public local notes, and trend tags carry the same seven-day history as a tag document (`following`/`featuring` reflect the viewer); search hashtags do too. Suggestions (`/api/v1/suggestions`, `/api/v2/suggestions`) are directory accounts the viewer has not followed, blocked, or muted; `/api/v1/trends/links` ranks link cards extracted from recent public notes and pages the ranking with `limit` and `offset`, and prefers a cached preview (Open Graph title, description, and image from `link_cards`) when the link has been unfurled, falling back to the bare host. Local and remote statuses carry a link preview (`card`): the first URL in the body (or remote `content`) is unfurled once, off the request path by the `ProcessLinkCard` queue job (transient failures — timeouts, 5xx, storage errors — are retried up to three times, while a refused or non-HTML link is settled) — a bounded fetch (3 s, 200 kB, refused for hosts the federation rules reject) parsed for Open Graph fields and cached in `link_cards` for a week (an older preview is refreshed the next time the link is posted or by the cron `RefreshLinkCards` job, a bounded batch of 20 per run, and a failed refresh keeps serving the stale card), with the result stored on the status row (`statuses.card_json`, `migration 0035`) or the remote row (`remote_statuses.card_json`, `migration 0036`); a failed fetch leaves `card: null` and never fails the post, and an edit or re-persist queues a refresh. v2 filters store keywords in `filters.keywords_json` (`migration 0030`), so `POST`/`GET`/`PUT`/`DELETE` `/api/v2/filters/:id` and the `:id/keywords` sub-resources work; a v1 read still sees the first keyword as `phrase`, which also stands in as the v2 `title`, the last keyword cannot be removed, and a filter can be narrowed to specific statuses (`filter_statuses`, `migration 0031`) which the v2 document reports as `statuses`. The home, list, and direct timelines (`home` context), the public, tag, and account-status collections (`public`), and search results, notifications (`public` / `notifications`), and remote statuses on the public timeline (matched against the text of their stored HTML) carry Mastodon's `filtered` attribute (`{filter, keyword_matches, status_matches}`) when a filter whose context is `public` (search) or `notifications` matches a keyword whole-word/substring or the narrowed status; expired filters are ignored. The action itself is the client's job, exactly as in Mastodon 4.x — a matching status is never dropped server-side, only marked — and `filter_action` stores only `warn` and `hide`, reading an unknown value (`blur` belongs to API version 5) as `warn`. Instance rules are read from the `INSTANCE_RULES` var. Custom emojis are read from the `CUSTOM_EMOJIS` var plus admin-managed rows; both surface on account/status/poll documents as the `emojis` array whenever their `:shortcode:` appears (inline `<img>` rendering inside `content` is not done). Admins (`requireAdmin`) manage rows under `/api/v1/admin/custom_emojis` (`GET`, `POST` multipart `shortcode` + `image`, `PATCH` `visible_in_picker`/`category` and optional replacement `image`, `DELETE`), with images stored in the media bucket under `emoji/`; a DB shortcode shadows a config one. Announcements come from the `ANNOUNCEMENTS` var plus runtime-authored rows (`announcements`, `migration 0021`) that admins manage under `/api/v1/admin/announcements` (`GET`/`POST`/`PUT`/`DELETE`, plus `POST /:id/publish|unpublish`); a stored announcement is public only while `published_at` is set and within `starts_at`/`ends_at`, and admin `text` is HTML-escaped and wrapped in a paragraph. Announcements are filtered to those live for the viewer; dismissals and reactions are per-viewer rows in `account_announcement_dismissals` / `account_announcement_reactions` (`migration 0015`), a reaction is accepted only when the announcement declares it or it is a configured custom emoji, and the announcement list requires authentication. Direct visibility is limited to the author and locally mentioned accounts (`status_mentions`); conversations group Direct threads by root status id; markers persist home/notifications read positions. Lists are per-account named member sets with optional `replies_policy` and a dedicated list timeline. Inbox accepts signed Follow / Undo / Like / Announce / Create that target this instance. Local actors verify against the stored account key. Remote actors verify against a cached `RemoteActor` public key, fetching and persisting the actor document from `keyId` on a cache miss. Remote `Create` / `Announce` Notes are stored as `RemoteStatus` (with up to four attachments from the ActivityPub `attachment` array, stored as `remote_statuses.media_json`, `migration 0028`) and appear on the public timeline with their media attachments rendered. Remote Like / Announce of a local status increment that status's favourite and reblog counts. `GET /api/v1/streaming` is a Durable Object WebSocket hub with write-time fan-out for updates and notifications. Media attachments carry alt text and a focal point: `PUT /api/v1/media/:id` sets `description` and `focus`, `DELETE /api/v1/media/:id` removes an attachment and its object, and both are rejected (422) once the media is attached to a status. Status create and edit accept the same metadata inline as `media_attributes` (a JSON array, or `media_attributes[N][id|description|focus]` form fields), applied only to media attached to that status and owned by the author. Admins list local accounts at `GET /api/v1/admin/accounts` (with `email` and `suspended`/`silenced`/`limited` flags) and set moderation with `POST /api/v1/admin/accounts/:id/silence|unsilence|suspend|unsuspend|enable` (`account_moderation`, `migration 0023`). A suspended account's authenticated requests answer 403 and `GET /api/v1/accounts/:id` answers 410; silenced and suspended authors are hidden from public and tag timelines, search, trends, and the directory (they remain visible on follower timelines). `POST /api/v1/admin/accounts/:id/sensitize|unsensitize` forces `sensitive` on the account's statuses while it has media (`account_flags`, `migration 0026`), and `DELETE /api/v1/admin/accounts/:id` purges the account: its bucket objects are removed first and every dependent row cascades.

Locked accounts collect pending follow requests from local followers (`follows.kind = 'Pending'`) and remote followers (`remote_follows.remote_request_kind = 'Queued'`). `GET /api/v1/follow_requests` lists both as account documents, most recent first. `POST /api/v1/follow_requests/:id/authorize` promotes the request to `Accepted`; for a remote follower it also delivers a signed `Accept` that references the original Follow activity to the follower's inbox. `POST /api/v1/follow_requests/:id/reject` deletes the pending request and, for a remote follower, delivers a signed `Reject`. Both endpoints return the requester `Relationship`; an unknown or non-pending id is `NotFound`.

Blocks and mutes are stored per viewer keyed by the target actor URI (`blocks`, `mutes`; `migration 0011`), with the local target account id recorded for local targets. `POST /api/v1/accounts/:id/block|unblock` and `.../mute|unmute` return the viewer `Relationship`; `mute` accepts `notifications` (default true) and `duration` seconds (0 or absent = no expiry). Blocks and active mutes hide the target's notes from the viewer's home, list, and direct timelines, and — as in Mastodon — a block also hides the viewer's notes from the blocked account (the `blocked_by` direction). Notifications exclude senders the viewer blocks and senders the viewer muted with `notifications`; a mute with `notifications=false` still hides the timeline but keeps notifications. A mute expires when `expires_at` passes. Unlike cfwdon, tstodon applies the block to these timelines (cfwdon filters only mutes) and leaves public/tag timelines unfiltered. `GET /api/v1/blocks` and `GET /api/v1/mutes` list the viewer's targets as account documents. Per-viewer domain blocks (`account_domain_blocks`, `migration 0024`) are managed with `GET`/`POST`/`DELETE /api/v1/domain_blocks` (the domain is normalized and the instance's own domain is rejected); a blocked domain's remote accounts report `Relationship.domain_blocking` and its statuses are dropped from the viewer's public timeline. Admins block whole domains with `GET`/`POST`/`PUT`/`DELETE /api/v1/admin/domain_blocks` (`domain_blocks`, `migration 0025`, `severity` of `silence`/`suspend`/`noop`): `suspend` refuses WebFinger and actor fetches, answers inbound activities from that domain with 403, and skips outbound delivery to it, while both `silence` and `suspend` hide its remote statuses from public timelines. A block with `reject_media` also drops the domain's remote attachments: newly persisted notes keep no media and an existing block clears the stored `media_json` for that domain. `GET /api/v1/instance/domain_blocks` publishes the non-`noop` blocks as `{domain, digest, severity, comment}` (SHA-256 digest, with `domain` replaced by the digest when `obfuscate` is set and only the public comment exposed). `GET /api/v1/instance/activity` bins the last 12 weeks from Monday 00:00 UTC, reporting `week` as UNIX seconds with `statuses`, `logins` (always `0`), and `registrations`. Endorsements (featured accounts) store a local account id or a remote actor URI in `endorsements` (`migration 0019`); `POST /api/v1/accounts/:id/endorse|unendorse` returns the viewer `Relationship` with `endorsed`, and `GET /api/v1/endorsements` plus the public `GET /api/v1/accounts/:id/endorsements` list them as account documents. Lists carry an `exclusive` flag accepted on create and update. `POST /api/v1/accounts/:id/note` stores a private note about a target (`account_notes`, `migration 0020`), returned as `Relationship.note` only to its author; a blank comment clears it. `GET /api/v1/accounts/familiar_followers?id[]=...` returns, per requested account, up to three accounts the viewer follows that also follow it. `POST /api/v1/accounts/:id/remove_from_followers` deletes the follow from a local follower (leaving the viewer's own follow of that account intact) or drops a stored remote follower and delivers a signed `Reject` to it. Notifications honor per-account actions: `POST /api/v1/notifications/:id/dismiss` records a dismissal, `POST /api/v1/notifications/clear` moves a clear marker, and `GET /api/v1/notifications/unread_count` counts visible notifications newer than the notifications marker (excluding cleared, dismissed, blocked, and notification-muted senders). The list accepts `types[]`, `exclude_types[]`, `account_id`, and the `max_id`/`since_id`/`min_id` cursors (`min_id` pages upward, ascending; the grouped v2 list takes them too), and `GET /api/v1/notifications/:id` returns a single notification with the same `filtered` attribute as the list (still addressable after it is dismissed, like Mastodon, and 404 for another account). The notification policy (`/api/v2/notifications/policy`, also settable with the legacy `filter_*` booleans) defaults to Mastodon's values (private mentions `drop`, limited accounts `filter`, everything else `accept`); `drop` skips creating a notification, `filter` holds it as a notification request — excluded from the list and unread count and listed by sender under `/api/v1/notifications/requests`, where each request carries the exact status that triggered it (`notification_requests.status_id`, `migration 0037`) — and accepting a sender merges their held notifications back, remembers them, and publishes a `notifications_merged` stream event, while dismissing discards them. The v2 instance document declares `api_versions: { mastodon: 2 }` for that 4.3-era surface. The grouped v2 endpoints fold a page of newest-first notifications into `notification_groups` (group key `{type}-{status_or_account}` for `favourite`/`reblog`/`follow`, `ungrouped-{id}` otherwise, restricted by `grouped_types[]`) with a shared `accounts`/`statuses` envelope; `limit` counts groups, dismiss drops every notification in a group, and the v2 unread count counts groups.

### Placeholder

None: every route listed above is implemented.

`OutboxDeliveryWorkflow` retries signed inbox POSTs per remote target. Cron enqueues `ProcessExpiredPolls`, which marks expired polls and pushes `status.update` onto the author's `StreamHub`. Status creates and notifications also publish onto per-account hubs.

### Out of scope

<!-- derived-from #principles -->

- Workers AI / Vectorize search
- Mastodon admin APIs beyond custom emojis, announcements, local-account moderation, and domain blocks
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
