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

## Done recently (do not re-open)

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
- Suggestions (v1/v2) and trends/links derived from local accounts and public notes
- Notifications: clear, dismiss, unread_count (marker-aware, honoring blocks/mutes)
- Path-safe remote account ids: `r_` + base64url actor URI; accounts/:id and follow request targets decode it
- Blocks + mutes: endpoints, relationship flags, home/list/direct timeline suppression, notification gating; `d1PrepareTyped` expands repeated `$N`
- Follow requests: list/authorize/reject for local + remote pending, Accept/Reject delivery, `remote_follows.follow_activity_id`
- json_each membership; TypedSQL fixed SQL; wrangler migrations SoT ADRs
- `runTypedBatch`; ExpandFollowers remote-only + chunked targets
- Create saga mentions-before-notify; `enqueueLocalActivity` Result
- Expired-poll bulk `mastodonStatuses`
- Analytics indexes: `outbox.expand`, `outbox.enqueue`, `search`, `timeline.tag`

## Active track

| ID    | Item                                                           | Status |
| ----- | -------------------------------------------------------------- | ------ |
| E2E-1 | process-compose multi-instance harness                         | done   |
| E2E-2 | Minimal 2-instance federation (WebFinger + Follow→Create)      | done   |
| E2E-3 | Undo/Like/Announce (+ Undo Like) e2e                           | done   |
| E2E-6 | Accept round-trip after remote Follow                          | done   |
| E2E-5 | Delete + shared-inbox-only fan-out e2e                         | done   |
| E2E-4 | Prefer worker-delivered Create/Accept (host hop fallback only) | done   |
