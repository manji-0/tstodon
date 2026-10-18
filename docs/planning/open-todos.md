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
