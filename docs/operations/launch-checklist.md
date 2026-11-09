# Launch Checklist

<!-- constrained-by ./cloudflare-deploy.md -->
<!-- constrained-by ./runbook.md -->

Go-live verification for a tstodon instance on a real Cloudflare account, after the [Cloudflare deploy checklist](./cloudflare-deploy.md) has been followed once. Each item says what to run, what you should see, and where to look when you do not. Day-2 procedures (backups, alerts, incidents) are the [operations runbook](./runbook.md).

Throughout, `wrangler` is `pnpm -C packages/worker exec wrangler` from the repository root, and:

```sh
D=social.example.com          # INSTANCE_DOMAIN
O=https://$D                  # INSTANCE_PUBLIC_ORIGIN
M=https://media.example.com   # MEDIA_PUBLIC_BASE_URL
```

## 1. Platform

### Resources provisioned and bound

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

- [ ] `wrangler d1 info tstodon` prints the database with a real id; `wrangler d1 migrations list tstodon --remote` reports no migrations to apply.
- [ ] `wrangler r2 bucket info tstodon-media` answers; `wrangler r2 bucket cors list tstodon-media` shows your `INSTANCE_PUBLIC_ORIGIN`.
- [ ] `wrangler queues info tstodon-outbox-process` and `wrangler queues info tstodon-outbox-dlq` each list the Worker `tstodon` as producer and as consumer, and the outbox consumer's dead-letter queue is `tstodon-outbox-dlq` (dashboard: Queues → `tstodon-outbox-process` → Settings). No consumer: re-apply Terraform with `attach_queue_consumer = true` (deploy checklist step 13) or redeploy.
- [ ] No `0000…` placeholder ids are left anywhere in `wrangler.jsonc`.
- [ ] `wrangler deployments status` shows one active version; the dashboard (Workers & Pages → `tstodon` → Settings → Bindings) lists `DB`, `MEDIA`, `OUTBOX_PROCESS_QUEUE`, `OUTBOX_DLQ`, `STREAM_HUB`, `RATE_LIMIT_COUNTER`, `OUTBOX_DELIVERY_WORKFLOW`, `METRICS`, `IMAGES`, `ASSETS` (no KV namespace and no `EMAIL`: both were removed, OPS-7).
- [ ] `wrangler workflows list` includes `tstodon-outbox-delivery`.
- [ ] The Worker placement region in `wrangler.jsonc` (`placement.region`) is near the D1 primary location.

### Secrets and vars

- [ ] `wrangler secret list` includes `BETTER_AUTH_SECRET` and `VAPID_PRIVATE_JWK`.
- [ ] `curl -s $O/api/v2/instance | jq .configuration.vapid.public_key` is a string, not `null`.
- [ ] `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (and `CF_ACCESS_ADMIN_GROUPS` if used) are in your deploy copy of `wrangler.jsonc` `vars` or set as secrets. Vars added only in the dashboard are dropped by the next `wrangler deploy` unless `keep_vars` is set **(verify)**.
- [ ] `INSTANCE_DOMAIN`, `INSTANCE_PUBLIC_ORIGIN`, `MEDIA_PUBLIC_BASE_URL`, `CONTACT_EMAIL`, `SOURCE_URL` are yours, not `example.com`: `curl -s $O/api/v2/instance | jq '{domain, source_url, contact: .contact.email}'`.
- [ ] `FEDERATION_ALLOW_HOSTS` is empty unless you mean limited federation (`curl -s $O/api/v2/instance | jq .configuration.limited_federation` is `false`); a leftover e2e host list silently refuses every other server.
- [ ] Nothing secret is committed: `git grep -n "BETTER_AUTH_SECRET\|\"d\":" -- packages/worker/wrangler.jsonc` finds nothing.
- [ ] Secure mode is what you chose ([Authorized fetch](../reference/configuration.md#authorized-fetch-secure-mode); off unless `AUTHORIZED_FETCH=true`). With it on: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' $O/users/alice/outbox` is `401`, `curl -s -H 'Accept: application/activity+json' $O/users/alice | jq 'keys'` lists only `@context`, `endpoints`, `id`, `inbox`, `outbox`, `preferredUsername`, `publicKey` and `type`, and `$O/actor` and `$O/.well-known/webfinger?resource=acct:alice@$D` still answer `200`. Either way, no Cache Rule caches `/users/*` regardless of the origin's `Cache-Control` (secure-mode answers are `private` and differ per signer).

### Cloudflare Access paths

<!-- constrained-by ./cloudflare-deploy.md -->

The deploy checklist (step 4) protects the browser paths and bypasses the federation, API and media paths. Without the Access cookie, protected paths redirect to Access and bypassed paths answer the Worker:

```sh
for p in / /auth/sign_in /settings /admin "/oauth/authorize?client_id=x"; do
  printf '%-28s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$O$p"
done
```

- [ ] Each prints `302` with a location on `<team>.cloudflareaccess.com`.

```sh
curl -s -o /dev/null -w '%{http_code}\n' $O/api/v1/instance                                    # 200
curl -s -o /dev/null -w '%{http_code}\n' "$O/.well-known/webfinger?resource=acct:<user>@$D"       # 200 once the account exists
curl -s -o /dev/null -w '%{http_code}\n' $O/.well-known/nodeinfo                                # 200
curl -s -o /dev/null -w '%{http_code}\n' $O/nodeinfo/2.0                                        # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' $O/users/<user> # 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' $O/actor        # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/activity+json' --data '{}' $O/inbox  # 400 (the Worker's ValidationError)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $O/oauth/token                                 # a 4xx JSON error, not 302
```

- [ ] None of these is a `302` to Access. A redirect on any of them breaks federation or API clients; fix the bypass application for that path. `/actor` (the instance actor and `/actor/inbox`) must be bypassed: remote servers fetch it to verify activities the instance actor signs (forwarded reports, for example).
- [ ] With the Access cookie, the protected paths answer the Worker. Get a token with `cloudflared access login $O` and then:

  ```sh
  T=$(cloudflared access token -app=$O)
  curl -s -o /dev/null -w '%{http_code}\n' -H "cf-access-token: $T" $O/auth/sign_in   # 200
  ```

  (or copy the `CF_Authorization` cookie from the browser and send it as `-H "Cookie: CF_Authorization=…"`).

- [ ] Media: `curl -sI "$M/<an object key>"` answers from R2 without Access (step 7 of the deploy checklist). If `MEDIA_PUBLIC_BASE_URL` is the Worker origin, `/media/*`, `/attachments/*`, `/avatars/*` and `/headers/*` must be bypassed.

If the browser loops between Access and the instance: `CF_ACCESS_AUD` or `CF_ACCESS_TEAM_DOMAIN` does not match the application ([runbook](./runbook.md#access-misconfiguration-or-admin-lockout)).

### Sign-in and the first admin

- [ ] Open `$O/` in a browser, sign in through Access. `/auth/sign_in` shows who Access signed in and the account was created (registrations open), or pending (approval), or nothing (closed: that is expected only if you created no account on purpose).
- [ ] The first admin: either `ADMIN_USERNAMES` named the username before its first sign-in, or `CF_ACCESS_ADMIN_GROUPS` matches a group the JWT carries. Check:

  ```sh
  wrangler d1 execute tstodon --remote --command \
    "SELECT a.username, a.access_email, u.role FROM accounts a JOIN \"user\" u ON u.id = a.auth_user_id"
  ```

  `role` includes `admin`; `$O/admin/dashboard` opens. If not, promote by hand ([Authentication](../reference/configuration.md#authentication)).

- [ ] An API token for the checks below. Register an app and authorize it out of band:

  ```sh
  curl -s -X POST $O/api/v1/apps -F client_name=launch-check \
    -F redirect_uris=urn:ietf:wg:oauth:2.0:oob -F 'scopes=read write follow push admin:read admin:write'
  # open in the signed-in browser, copy the code it shows:
  #   $O/oauth/authorize?response_type=code&client_id=<id>&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=read+write+follow+push+admin:read+admin:write
  curl -s -X POST $O/oauth/token -F grant_type=authorization_code -F code=<code> \
    -F client_id=<id> -F client_secret=<secret> -F redirect_uri=urn:ietf:wg:oauth:2.0:oob
  TOKEN=<access_token>
  curl -s -H "Authorization: Bearer $TOKEN" $O/api/v1/accounts/verify_credentials | jq .acct
  ```

  Revoke it when you are done (`$O/auth/edit`, authorized apps).

### Posting with media; metadata is stripped

<!-- constrained-by ../reference/configuration.md#media-metadata -->

- [ ] Make a JPEG with a GPS position and upload it:

  ```sh
  exiftool -GPSLatitude=35.6586 -GPSLatitudeRef=N -GPSLongitude=139.7454 -GPSLongitudeRef=E -Make=TestCam test.jpg
  exiftool -gps:all -make test.jpg                       # shows the position and make
  curl -s -H "Authorization: Bearer $TOKEN" -F file=@test.jpg $O/api/v2/media | tee media.json | jq '{id, url, preview_url, blurhash}'
  ```

  Expected: an `id`, a `url` on `MEDIA_PUBLIC_BASE_URL`, a `preview_url` and a `blurhash` (the `IMAGES` binding works; a missing preview means `MediaImageNotProcessed` in the logs).

- [ ] The stored file has no metadata: `curl -s "$(jq -r .url media.json)" -o stored.jpg && exiftool -gps:all -make stored.jpg` prints nothing. In D1, `SELECT metadata_stripped_at, file_size FROM media_attachments WHERE id = '<id>'` is set.
- [ ] Post it: `curl -s -H "Authorization: Bearer $TOKEN" -F status='launch check' -F "media_ids[]=$(jq -r .id media.json)" $O/api/v1/statuses | jq .url`, then open the post in the web UI; the image loads from the media hostname (no CORS error in the browser console).

### Web Push

- [ ] In the web UI, turn on desktop notifications (the notifications column's settings) and allow them in the browser. `wrangler d1 execute tstodon --remote --command "SELECT COUNT(*) FROM push_subscriptions"` is at least 1.
- [ ] From a second account (or a remote one), favourite a post of yours; the browser shows a notification. The `push.deliver` metric records the push service's status (`201` expected; [query](./runbook.md#analytics-engine-metrics)). 401/403 mean the VAPID key and subscription disagree.

### Rate limits and IP blocks

<!-- constrained-by ../reference/configuration.md#rate-limits -->

- [ ] `curl -si $O/api/v1/instance | grep -i '^x-ratelimit'` shows `X-RateLimit-Limit: 300`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Absent: `RATE_LIMITS_ENABLED` is off, or the `RATE_LIMIT_COUNTER` binding is missing. `rate limit counter unavailable` in the logs means the Durable Object fails (limits fail open).
- [ ] With a token: the headers show the token's or account's budget (`300` or `1500`).
- [ ] The WAF rate-limiting rule from the [deploy checklist](./cloudflare-deploy.md#rate-limiting-at-the-edge) exists (zone → Security → WAF → Rate limiting rules).
- [ ] IP block sanity, from a second network you can switch to (a phone hotspot), never your admin address:

  ```sh
  curl -s -H "Authorization: Bearer $TOKEN" -X POST $O/api/v1/admin/ip_blocks \
    -F ip=<hotspot address>/32 -F severity=no_access -F expires_in=600 -F comment='launch check' | jq .id
  ```

  Within a minute, any request from the hotspot gets `403 Forbidden` (even `/api/v1/instance`); from your main network everything still works. Delete it: `curl -s -H "Authorization: Bearer $TOKEN" -X DELETE $O/api/v1/admin/ip_blocks/<id>`. If you blocked yourself, remove the row with `wrangler d1 execute` ([runbook](./runbook.md#inbox-flood)).

### Crons and the queue consumer

- [ ] After the next minute 17, the `cron` metric has a point for `17 * * * *` (query in the [runbook](./runbook.md#analytics-engine-metrics)), and `wrangler tail tstodon --format pretty` around that minute shows the scheduled event followed by queue batches.
- [ ] `outbox.job.page` points appear for `ProcessExpiredPolls` (hourly) and, after the six-hourly run, `VacuumMediaAttachments`, `VacuumActivities` (also an `ActivityVacuumPass` log line), `StripStoredMediaMetadata`, `BackfillStoredMediaSizes`.
- [ ] The queue backlog (dashboard: Queues → `tstodon-outbox-process`) drains to zero between runs.

### Backups and monitoring

- [ ] `wrangler d1 time-travel info tstodon` returns a bookmark (Time Travel is on).
- [ ] The `D1 backup` workflow is configured ([Scheduled D1 backups](./runbook.md#scheduled-d1-backups)): the secrets and variables are set, the Cloudflare token has D1 Edit only, the bucket is in another account (or provider) with a lock rule, and the age identity is stored by two custodians outside GitHub and Cloudflare.
- [ ] A manual run (Actions → D1 backup → Run workflow) succeeds, and its object `d1/tstodon-<stamp>.sql.gz.age` is in the bucket (`aws s3api head-object` shows the `sha256` metadata).
- [ ] That backup restores: `scripts/d1-restore-check.sh <file> <identity>` decrypts it with the custodians' key and loads it into a scratch local database with the expected account count and no missing migrations ([Restore from a scheduled backup](./runbook.md#restore-from-a-scheduled-backup)). Optionally also load it into a scratch remote database (`wrangler d1 create tstodon-restore-test`, `wrangler d1 execute tstodon-restore-test --remote --file restore.sql`) and delete it afterwards.
- [ ] The next scheduled run appears in the Actions tab the following day, and the alert on a failed or missing run is set ([Suggested alerts](./runbook.md#suggested-alerts)).
- [ ] Media is copied somewhere else on a schedule ([R2 media](./runbook.md#r2-media)).
- [ ] The secrets inventory is in your vault ([runbook](./runbook.md#secrets-and-configuration-inventory)).
- [ ] An uptime check on `/api/v1/instance` (or `/healthz` with a bypass), and the alerts you chose from [Suggested alerts](./runbook.md#suggested-alerts), are live; an Analytics Engine query with your token returns rows.

## 2. Federation smoke test

<!-- constrained-by ./runbook.md#log-events -->

Use an account you control on a real Mastodon 4.5 or newer server (4.5 is the first with FEP-044f quote posts) and, ideally, one on Misskey. Below, `alice@$D` is yours on tstodon and `bob@remote.example` is the remote one. Each step names where to look when it fails:

- **Requests to us**: Workers Logs filtered on the inbox paths (`/inbox`, `/users/alice/inbox`, `/actor/inbox`) and their status: `202` accepted; `401 InvalidSignature` (key fetch or signature failed); `403` (domain blocked, not on the allow list, suspended actor); `429` (rate limit); `503 VerificationUnavailable` (could not fetch the signer's key). Every refusal is an `InboxRefused` event whose `reason` says which ([Inbox refusals](./runbook.md#log-events)). What was accepted is in `inbox_activities` (`SELECT kind, created_at FROM inbox_activities ORDER BY created_at DESC LIMIT 20`).
- **Deliveries from us**: `outbox_deliveries` for the remote host ([failing-host query](./runbook.md#outbound-delivery-health-d1)), `wrangler workflows instances list tstodon-outbox-delivery`, and the `*NotFederated` / `Outbox*` [log events](./runbook.md#log-events).

tstodon signs its outgoing ActivityPub GETs as the instance actor (`$O/actor#main-key`), so the test also works against a remote in Mastodon's secure mode (`AUTHORIZED_FETCH=true`); step 17 checks that. WebFinger is unsigned, as Mastodon sends it.

| #   | Step                     | Do                                                                                                                                                                                                         | Expected                                                                                                                                                               | If it fails                                                                                                                                                          |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | WebFinger, them → us     | On Mastodon, search `@alice@$D`                                                                                                                                                                            | The profile shows, with avatar, bio and post count                                                                                                                     | `curl "$O/.well-known/webfinger?resource=acct:alice@$D"`; Access bypass of `/.well-known/*` and `/users/*`; `FEDERATION_ALLOW_HOSTS`                                 |
| 2   | WebFinger, us → them     | `curl -s -H "Authorization: Bearer $TOKEN" "$O/api/v2/search?q=@bob@remote.example&resolve=true" \| jq '.accounts[0].acct'`, or search in the web UI                                                       | `bob@remote.example`                                                                                                                                                   | The remote's WebFinger answers (unsigned) and its actor answers our signed GET (`FetchNotSigned`); domain blocks / allow list here                                   |
| 3   | Follow, us → them        | Follow bob from the web UI                                                                                                                                                                                 | Relationship `following: true` (after `requested` if bob is locked and approves)                                                                                       | `Follow` row for bob's inbox in `outbox_deliveries`; the `Accept` in `inbox_activities`                                                                              |
| 4   | Follow, them → us        | Follow alice from Mastodon                                                                                                                                                                                 | Mastodon shows "Following" (or "Requested" if alice is locked; approve in the web UI); alice gets a follow notification                                                | Inbox `202` for the `Follow`; the `Accept` delivery row                                                                                                              |
| 5   | Post, us → them          | Post a public status as alice                                                                                                                                                                              | It appears in bob's home timeline within a minute                                                                                                                      | `outbox.enqueue` for `Create`; the delivery row to the remote's shared inbox is `Delivered`; `StatusNotFederated`                                                    |
| 6   | Post, them → us          | Post as bob                                                                                                                                                                                                | It appears in alice's home timeline (streaming, or on reload)                                                                                                          | Inbox `202` and a `Create` in `inbox_activities`; `FanOutHome` in `outbox.job.page`; `*FanOutNotPublished` only affects live updates                                 |
| 7   | Reply                    | Reply both ways                                                                                                                                                                                            | Each reply shows under its parent on both sides (thread context)                                                                                                       | As 5 and 6; `ThreadBackfillNotQueued`                                                                                                                                |
| 8   | Boost                    | Boost each other's post; then unboost                                                                                                                                                                      | The boost shows in the other's timeline, a reblog notification arrives; the unboost removes it                                                                         | `Announce` / `Undo` delivery rows; `UnreblogNotFederated`                                                                                                            |
| 9   | Favourite                | Favourite each other's post                                                                                                                                                                                | Favourite notification on both sides, counts update                                                                                                                    | `Like` delivery row; `InteractionNotFederated`                                                                                                                       |
| 10  | Mention                  | Mention `@bob@remote.example` from alice, and `@alice@$D` from bob                                                                                                                                         | A mention notification on each side                                                                                                                                    | The `Create` to bob's personal inbox; inbox `202` here                                                                                                               |
| 11  | Quote (Mastodon 4.5+)    | Quote alice's public post from Mastodon; quote bob's post from tstodon (`quoted_status_id`)                                                                                                                | Mastodon shows the quote as accepted (it fetched the stamp at `$O/users/alice/quote_authorizations/<id>`); here the quote's `quote.state` is `accepted`                | `status_quotes.state` stays `pending`; `QuoteRequestNotSent`, `QuoteRequestAnswerNotSent`, `QuoteAnswerNotAnnounced`; Access bypass of `/users/*`                    |
| 12  | Edit                     | Edit alice's post (`PUT /api/v1/statuses/:id`); edit bob's on Mastodon                                                                                                                                     | The other side shows the new text and "edited" (the `Update(Note)` carries `updated`); `GET /api/v1/statuses/:id/history` here lists both versions of bob's post       | `StatusUpdateNotFederated`; the `Update` delivery row                                                                                                                |
| 13  | Delete                   | Delete a post on each side                                                                                                                                                                                 | It disappears from the other side's timelines                                                                                                                          | `StatusDeleteNotFederated`; the `Delete` delivery row                                                                                                                |
| 14  | Profile update           | Change alice's bio and avatar (`PATCH /api/v1/accounts/update_credentials` or the profile page)                                                                                                            | Mastodon shows the new bio and avatar (it may cache the profile for a while; opening the profile refetches it)                                                         | `ProfileUpdateNotFederated`; the avatar URL loads from the media hostname without Access                                                                             |
| 15  | Account move (optional)  | On the target Mastodon account, add `alice@$D` as an alias (Account → Moving from a different account), then move alice to it from `$O/settings/migration`                                                 | Mastodon followers of alice follow the target; alice shows as moved                                                                                                    | The `Move` delivery rows; `MoveFollowsNotQueued`; `outbox.job.page` `MoveFollows` for a move into tstodon                                                            |
| 16  | Report forwarding (opt.) | Report bob from alice with "forward to remote" (`POST /api/v1/reports` with `forward=true`)                                                                                                                | The remote's moderators see a report from your instance (signed by the instance actor)                                                                                 | `ReportForwardFailed`; the remote fetches `$O/actor` to verify, so `/actor` must be bypassed                                                                         |
| 17  | Secure mode (opt.)       | Against a Mastodon with `AUTHORIZED_FETCH=true` (secure mode): repeat step 2 with an account there you have not looked up yet, then open one of its posts by URL (search the post URL with `resolve=true`) | The account and the post resolve. On the remote, its access log shows our GETs with a `Signature` header whose `keyId` is `$O/actor#main-key`, and a GET of `$O/actor` | `curl -s -H "Accept: application/activity+json" $O/actor \| jq .publicKey.id` answers without Access; `FetchNotSigned` in Workers Logs; the remote blocks our domain |

**Misskey** (optional): steps 1–10 apply. Misskey sends emoji reactions as `Like`, so each reaction shows here as a favourite (tstodon has no emoji reactions). A Misskey quote (renote with text) arrives with `_misskey_quote` / `quoteUrl` and shows as a quote; Misskey does not send FEP-044f `QuoteRequest`s, so step 11 does not apply.

When every row passes, revoke the launch-check token, delete the test posts, and keep the federation test accounts for the next upgrade's smoke test.
