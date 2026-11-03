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

## Direct messages (open)

| ID   | Item                           | Notes                                                                                                                                                                                                                                                       |
| ---- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM-8 | Context paging after filtering | `/context` caps each level before the visibility and block filters, so a count-limited thread can come back short. Mastodon does the same (`ancestor_ids(limit)` / `descendant_ids(limit, depth)` before filtering), so this stays unless parity is dropped |

## Done recently (do not re-open)

- Remote profile backfill. A view of `GET /api/v1/accounts/r_…/statuses` claims the actor with one `UPDATE` on `remote_actors.outbox_fetched_at` (`OUTBOX_BACKFILL_TTL_MS`, 24h) and queues one `BackfillRemoteOutbox { actorUri }` job; the response shows what is cached. `remote_actors` now keeps `outbox_uri` and `featured_uri` from the actor document (migration 0082); an actor cached before that is refetched once by the job. The job reads the outbox's first page, at most `OUTBOX_BACKFILL_ITEM_LIMIT` (20) items: a public or unlisted `Create` of the actor's own note from its host is stored through `persistRemoteObject`, an `Announce` through `persistAnnouncedObject` (third-party origin checks) and `recordRemoteBoost`; embedded objects from another host or attributed to someone else are not trusted, and cached items are no-ops. Backfilled notes and boosts take ids from their `published` time (`entityIdAt`, zero-padded to 18 digits so string order is time order before mid-2018), as Mastodon's Snowflake ids do, so they sort where they were written on the profile, home, and lists instead of looking new; nothing is fanned out and no mention is notified. The `featured` collection (same cap) fills `remote_actor_pins` (migration 0083), replaced on each backfill and kept when the collection cannot be read; `pinned=true` on a remote profile lists those notes. Not done: a second outbox page, account lookup triggering a backfill, and backfilling replies or threads.
- Remote accounts on profiles and lists. `GET /api/v1/accounts/r_…/statuses` lists the cached actor's notes and boosts, newest first, with `max_id`/`since_id`/`min_id`, `limit`, `exclude_replies`, `exclude_reblogs`, `only_media`, and `tagged` (the last three leave boosts out, as in Mastodon). Public and unlisted entries are open to everyone, followers-only ones to accepted followers, and notes that mention the viewer to that viewer. A boost needs a public or unlisted target whose author the viewer does not block or mute. The list is empty when the viewer blocks the actor or its domain or the instance suspends that domain, and for `pinned=true`. An uncached actor answers 404. A list member is now `{ kind: "LocalAccount", accountId } | { kind: "RemoteActor", actorUri }`. Remote members live in `account_list_remote_members` (migration 0081: `list_id`, `outbound_follow_id`, both `ON DELETE CASCADE`). Mastodon's `ListAccount` belongs to a `Follow` in the same way, so unfollowing, a `Reject`, a `Move`, or an actor purge drops the memberships. `POST /api/v1/lists/:id/accounts` takes `r_…` ids of accepted follows and answers 422 for any other remote account, adding nothing. `DELETE`, `GET /api/v1/lists/:id/accounts`, and `GET /api/v1/accounts/r_…/lists` handle both kinds. The list timeline uses the same pipeline as home (`feedDocuments` in `src/timeline-documents.ts`, with a `FollowedFeed` of `Home` or `List`), so blocks, mutes, muted conversations, domain blocks, filters, and the follow's `languages`/`reblogs` apply to remote members' notes and boosts. It now pages by all three id cursors. `replies_policy: none` drops remote replies, and `followed` keeps those that answer a followed remote actor. Not done: `exclusive` lists hiding their members from home (local members are not hidden either), `replies_policy: list` limiting replies to list members (local or remote), `followed` counting remote replies to local posts, carrying list memberships over on a `Move` as Mastodon does, and the `list` stream.

- Public, hashtag, and list streaming. Each streaming socket keeps its own subscriptions in its WebSocket attachment (so hibernation keeps them): the `stream` query parameter (with `tag` / `list`) and later `subscribe` / `unsubscribe` messages, which is how the web UI multiplexes every column over one socket. The streams are `user`, `user:notification`, `public`, `public:local`, `public:remote`, their `:media` variants, `hashtag`, `hashtag:local`, and `list`. Each event is tagged with the stream it was subscribed on (`["hashtag", "cats"]`, `["list", "<id>"]`); notifications now reach `user` sockets as `["user"]`, since the web UI ignored the old `["user", "user:notification"]`. `user*` need the token's account, a list its owner (`Not authorized to stream this list`), and public and hashtag streams are open without a token, as their timelines are. A `StreamHub` mirrors its sockets' public, hashtag, and list subscriptions into `stream_subscriptions` (migration 0084), one row per distinct channel: inserted before the first socket takes it and deleted after the last lets go, with every change run in arrival order; a row left behind is removed when a fan-out finds no socket behind it. A hashtag stream needs a hashtag name (letters, digits, underscores, at least one letter, at most 100 UTF-16 units; otherwise `Invalid tag name parameter`). A socket holds at most 32 streams (`MAX_SOCKET_CHANNELS`) and a hub at most 32 distinct hashtag and list streams (`MAX_HUB_TAGGED_CHANNELS`, public streams not counted); past either the subscribe gets a 429 error frame and no row. Every anonymous socket shares one hub, so they share those 32: one client holding them all keeps other anonymous sockets off new hashtags until it lets go. A public local note, a public remote note delivered live to the inbox (never a backfilled one), and their edits and deletes queue `FanOutPublic { event, entryId, afterHub }`. It pages the hubs holding a public or hashtag subscription that may carry the status (20 per job) and asks `publicTimelineDocuments` / `tagTimelineDocuments` (the functions the REST timelines use) for that one entry for the hub's viewer, so blocks, mutes, domain blocks, and `filtered` apply as on the timeline; `delete` goes to every public and hashtag subscription. The home fan-out also looks up its page of followers' open list streams and asks `listTimelineDocuments` for the entry. Cost: one query per page of hubs, then one timeline query per matching subscription per hub (not per socket); hubs without such a subscription cost nothing. A page stops before the hub that would take it past 38 timeline passes and queues the rest. A hashtag matches when the status's text holds `#tag` as a plain substring (local) or its `remote_status_tags` row (remote); local statuses still have no tag table, so `#cats` also matches `#catsitting`, as the tag timeline does. The public and tag timelines now also leave out authors the viewer blocks or mutes, in their queries so a page is filled past them, and the public timeline takes `only_media`. Not done: the `direct` stream; filtering remote actors on blocked or limited domains in the public and tag queries (they are still dropped after the `LIMIT`, so such a page can come back short); per-stream token scopes (`read:statuses`, `read:notifications`); SSE (`/api/v1/streaming/public` and the like); paging the remote half of the public timeline by `max_id`.
- Home streaming like Mastodon's `FanOutOnWriteService`: a local post, local boost, local edit, local delete, and unboost, and an inbox `Create`, `Announce`, `Undo{Announce}`, `Delete`, and note `Update` from a remote actor, queue a `FanOutHome { event, entryId, author, afterAccountId }` job. The job pages the author's local followers (accepted local `follows` and accepted `outbound_follows`), 20 per job, and chains a job for the next page, like `MoveFollows`. For `update` and `status.update`, each follower gets the entry only when `homeTimelineDocuments` (the function `GET /api/v1/timelines/home` uses) returns it for that follower under the `onlyId` cursor. So blocks, mutes, muted conversations, domain blocks, and follow `reblogs`/`languages` apply as on the timeline, and the document is rendered for that follower, with its `filtered` matches. `delete` goes to every follower. A redelivered job only re-sends the events. The author still hears its own post at once, and now also its boost, edit (as `status.update`), delete, and unboost. The `list` streams ride on this fan-out (see public, hashtag, and list streaming above). Not done: `delete` for local reblogs of a deleted status sent to the rebloggers' followers; `delete` for every status of a remote actor that is deleted.

- Remote boosts on home: a signed inbox `Announce` of a local note or of a remote note becomes a `remote_boosts` row (migration 0080: its own id from the status id space, the booster's `actor_uri`, the unique `activity_id`, exactly one of `local_status_id` / `remote_status_id`, the `Announce`'s visibility from its `to`/`cc`, `published_at`). As in Mastodon, only a public or unlisted status can be boosted, a direct `Announce` is dropped, and an actor keeps one boost per status. A remote note that is not cached yet is fetched from its URI: the booster's own note may come embedded, another actor's note must name that URI as its id and come from its author's host, and is stored under its author. A local note still gets its `remote_announces` row and the author's `reblog` notification. `Undo{Announce}` signed by the booster deletes the row by the Announce id; deleting the boosted status or purging the booster cascades. The home timeline merges the boosts of accepted remote follows with `reblogs` on, by the same id cursors, leaving out blocked or muted boosters and original authors and their blocked or suspended domains. A boost renders as a Mastodon status with the booster as `account`, the local or remote status as `reblog`, and the `Announce` id as `uri`, and `GET /api/v1/statuses/:id` serves it (a followers-only boost only to the booster's followers). Not done: remote boosts on public and tag timelines (Mastodon keeps boosts off them), `filtered` and muted threads on boosts, and Mastodon's reblog aggregation on home.

- A followed remote account moving: an inbox `Move{object: A, target: B}` signed by A counts only when `object` is the signer and B's actor document, fetched fresh through the federated fetch (allow list and suspended domains apply), lists A in `alsoKnownAs`; anything else is a 202 no-op. B is cached and A's `remote_actors.moved_to` (migration 0077, written only by a verified `Move`, untouched by actor refreshes) points at it, so `GET /api/v1/accounts/r_A` renders `moved` with B's account. Every local `outbound_follows` row of A (`Requested` or `Accepted`) moves as in Mastodon's `UnfollowFollowWorker`: follow B as `Requested` with the same reblogs/notify/languages and send `Follow` to B's inbox (a follow of B that already exists is kept untouched), then delete the follow of A and send it `Undo(Follow)`, then notify the follower with a `move` notification (`account` A, `target` B via `notifications.target_account_id`, migration 0078). A follower who blocks B, has a domain block for B's domain, or whose federation limits refuse B keeps the follow of A and gets nothing. The work is idempotent (a redelivered `Move` finds no rows left). Fan-out is paged: the `Move` itself moves the first `MOVE_PAGE_SIZE` (50) follows in id order (index in migration 0079) and a full page queues a `MoveFollows { fromActorUri, toActorUri, afterId }` job on `OUTBOX_PROCESS_QUEUE` for the next, so one request does bounded work and large followings need no inline cap. Followers of local accounts need nothing: B sends its own `Follow`, as Mastodon expects. Follow-ups: carrying blocks, mutes, and account notes over as `MoveWorker` does, `movedTo` from an actor document seen before any `Move` (needs the same `alsoKnownAs` check), retrying a `Move` whose target fetch failed (the inbox records the activity id first, so a redelivery is dropped), local accounts moving away (`Move` out), and `move` in grouped notifications' push alerts.

- Following remote accounts: `POST /api/v1/accounts/r_…/follow` records the follow in `outbound_follows` (migration 0076, one row per account and actor with its `follow_activity_id`, `state` `Requested` or `Accepted`, and the `reblogs`/`notify`/`languages` options) and sends `Follow` to the actor's inbox once; following again only updates the options. A suspended domain, one outside the allow list, a blocked actor, or a blocked domain answers 403. A signed `Accept` from the followed actor (naming our `Follow` id, or embedding a `Follow` of it by a local actor) makes it `Accepted`; a `Reject` deletes it; another actor's answer is ignored. `unfollow` deletes the row and sends `Undo(Follow)`. Accepted remote follows count in `following_count`, list in `/api/v1/accounts/:id/following` and the AP `following` collection, and show in the Relationship (`requested` until accepted). The home timeline merges the followed actors' public, unlisted, and followers-only notes (follow `languages[]`, blocks, mutes, domain blocks, suspended domains, and muted threads applied; silenced domains still shown to followers), and followers-only remote notes open for accepted followers. Remote notes now take their language from `contentMap`. The row id is the cursor and `actor_uri` can be re-pointed, so a `Move` can carry a follow over. Follow-ups: `notify` status notifications for remote posts, `followed_by` from `remote_follows`, severing follows when a domain is suspended later, `Undo(Follow)` when a local account is deleted, and `following=true` account search for remote accounts.

- Poll `Update(Question)` debounce, as Mastodon's `DistributePollUpdateWorker`: a vote (remote on a local poll, or local through `POST /api/v1/polls/:id/votes`) on a poll that shows its totals claims `polls.update_queued_at` (migration 0075, one `UPDATE ... WHERE update_queued_at IS NULL RETURNING id`) and only the claiming vote sends a `DistributePollUpdate { pollId }` job with `delaySeconds: 180` (`POLL_UPDATE_DELAY_SECONDS` in `src/poll-update.ts`); a failed send releases the claim. The job clears the claim first, so later votes queue a fresh job, then federates one `Update(Question)` with the counts as they are. Local votes sent no `Update` before; they do now, so remote audiences see them.

- Local polls federate as Mastodon polls: `noteDocument` serializes a note with a poll as a `Question` (`oneOf`/`anyOf` options with `replies.totalItems`, `endTime`, `closed` once expired, `votersCount` via the `toot:` context term; counts withheld while `hide_totals` is on) in the `Create`, the note document, the stored outbox `Create` and the edit `Update`. An inbox `Create` of a content-less `Note{name, inReplyTo: <local poll note>}` is a vote: counted in `remote_poll_votes` (migration 0073; single choice takes one option per actor, multiple choice one vote per option, expired polls, unknown options, repeats and followers-only polls from non-followers are ignored), never stored as a remote status and never a mention notification; counts and `voters_count` (now a real distinct-voter count for every poll) include remote votes, and the counted votes federate an `Update(Question)` to the note's audience (debounced, see below). Follow-ups: the outbox collection serves the `Create` as stored, so its poll counts are those at posting time; purge a deleted remote actor's poll votes, and decrement counts when a vote is retracted.

- Inbox account `Delete`: a remote actor deleting itself (signed with its cached key, object equal to its own URI, bare or embedded) purges its `remote_actors` row, which cascades to its statuses, follows, favourites and announces, plus its notifications and the blocks, mutes, endorsements and notes keyed by its URI. Another actor's URI is ignored, and a repeat from an already purged actor is a 202. Follow-ups: pending outbox deliveries to its inbox, and thread mutes or conversation read/hide rows pointing at its purged statuses

- Voting on a remote poll: `POST /api/v1/polls/remote-<id>/votes` validates (visible, not ended, choices in range, one choice for a single-choice poll, one vote per account, author domain not suspended, blocked by the voter, or outside the allow list), stores the votes in `remote_poll_own_votes`, and federates one `Create(Note{name, inReplyTo, to: author})` per choice to the author's own inbox. The Poll entity carries `voted` and `own_votes` on every remote status render, and the votes are added to the displayed counts until the author's next changed `Update(Question)` tally replaces them. The vote Notes are not served at their `/users/:name/statuses/:id` URIs (Mastodon does not dereference them either).
- Remote polls, read-only: a remote `Question` (`oneOf` single, `anyOf` multiple choice, option counts, `endTime`/`closed`, `votersCount`) is stored in `remote_statuses.poll_json` and rendered as the Mastodon Poll entity (id `remote-<status id>`, also served by `GET /api/v1/polls/:id`); an author `Update(Question)` refreshes counts without setting `edited_at`. Follow-ups: poll custom emoji, and expiry notifications for remote polls.

- Inbox `Update`: a remote edit of a cached note (author-checked, `edited_at` rendered, newer edit wins, new mentions notified once) and a remote actor profile refresh. Follow-ups: edit history (`/history`) for remote statuses, `update` notifications for reblogs once local reblogs of remote statuses exist

- Cloudflare Access replaced by Void Better Auth (passkey-only sign-up/sign-in, admin plugin roles) and a first-party Mastodon OAuth 2 server (apps, consent, `authorization_code` + PKCE, `client_credentials`, revoke, RFC 8414 metadata) with Mastodon's per-endpoint granular scope enforcement

- Remote statuses render `in_reply_to_id` / `in_reply_to_account_id` from their stored `inReplyTo`

- Thread context spans local and cached remote statuses (either id; remote replies to local notes included)

- Local notes reply to cached remote statuses (`statuses.in_reply_to_uri`): rendered parent, `inReplyTo` on every federated note, direct replies grouped into the remote conversation

- Local notes mention remote accounts (`@user@domain`): Mention tags, Mastodon addressing, delivery by addressing (direct notes to mentioned inboxes only), `mentions` rendered

- Remote direct notes reach the addressed account's direct timeline and conversations (`remote_status_mentions`, replies grouped by `inReplyTo`), and open for it on `GET /api/v1/statuses/:id`

- Remote Follow/Like/Announce and mentions in new remote notes notify the local target (`r_…` senders, deduplicated, block/mute/domain-block aware); remote accounts can be blocked and muted

- Web Push: subscriptions per OAuth access token (WP-2; replaced by the token's next `POST`, removed with the token), VAPID key advertised, notifications delivered (`aes128gcm`/`aesgcm`, VAPID ES256)

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
- DM-4: a muted conversation covers remote replies too (their reply chain is walked back to the local root), and, as in Mastodon's NotifyService, no notification is created for a status in a muted conversation, so the v1 list, grouped v2 list, unread counts, and push agree (only the v1 list used to filter, and only local statuses)
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
