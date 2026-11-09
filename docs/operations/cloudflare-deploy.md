# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->
<!-- constrained-by ../reference/configuration.md#authentication -->
<!-- constrained-by ../reference/configuration.md#web-ui -->
<!-- constrained-by ../reference/configuration.md#rate-limits -->

1. Provision Cloudflare resources with [`infra/cloudflare`](../../infra/cloudflare/README.md) (`tofu apply`): D1, R2, the outbox Queue `tstodon-outbox-process` and its dead-letter queue `tstodon-outbox-dlq` (`outbox_dlq_name`). A deployment from before OPS-7 also has the KV namespaces `REMOTE_DNS_CACHE` and `APP_CACHE`, which nothing uses any more: deploy this version (it binds neither), then let `tofu apply` destroy them (see the [infra README](../../infra/cloudflare/README.md#suggested-apply-order)).
2. Copy `tofu output -json wrangler_bindings` into production `packages/worker/wrangler.jsonc`, and pin the account there (`account_id`) or export `CLOUDFLARE_ACCOUNT_ID` (replace placeholder D1 / R2 / queue identifiers; the producers `OUTBOX_PROCESS_QUEUE` and `OUTBOX_DLQ` name the two queues).
3. Put the Better Auth signing secret, once: `openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET` (see [Authentication](../reference/configuration.md#authentication)). Without it every request fails off localhost. It signs the user and session rows; it is not the login. Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` for the Access application. When `CF_ACCESS_ADMIN_GROUPS` is non-empty, every Access login sets or clears admin from those groups. `ADMIN_USERNAMES` grants admin only the first time that user row is created, so use it for the first admin while the group list is empty. Set `REGISTRATIONS_OPEN` / `REGISTRATION_APPROVAL` as wanted. Access already verified the email, so sign-up does not mail a confirmation link. An existing account links only when the Access email equals `access_email` exactly; another spelling creates a second account when registrations are open and locks the person out when they are closed. `signedInAt` is the Access JWT `iat`. Access can re-issue an app token from a still-valid org session, so account move, session end, and app revoke need a short Access session lifetime if you want a fresh sign-in. The server sends no mail, so there is no mail binding or sender to set up.
4. Put Cloudflare Access in front of the browser paths, not the whole site. A whole-site application blocks federation and API clients. Protect `/`, `/auth/*`, `/oauth/authorize`, and `/settings`. `/oauth/authorize` reads the Access JWT. Bypass `/api/*`, `/oauth/token`, `/oauth/revoke`, `/.well-known/*`, `/users/*`, `/inbox`, `/actor` (the instance actor and `/actor/inbox`: remote servers fetch it to verify what it signs, such as forwarded reports), `/nodeinfo`, and media (`/media/*`, `/attachments/*`, `/avatars/*`, `/headers/*`). Login is Access (its own passkeys, or an identity provider such as WorkOS). API clients still send `Authorization: Bearer` tokens this server issued.
5. Put the Web Push key as a secret, once: `wrangler secret put VAPID_PRIVATE_JWK` (see [Web Push](../reference/configuration.md#web-push)); optionally set `VAPID_SUBJECT`.
6. Authenticate wrangler (`wrangler login`, or `CLOUDFLARE_API_TOKEN` with Workers Scripts:Edit plus read on the bound resources). The deploy step below applies remote D1 migrations itself.
7. Put the media bucket on a public hostname (R2 custom domain) and set `MEDIA_PUBLIC_BASE_URL` to that origin. Object keys under the bucket are the URL path (`attachments/…`, `avatars/…`, `headers/…`). See [Configuration — Media public URLs](../reference/configuration.md#media-public-urls).
8. Apply R2 CORS for browser reads of that hostname. Copy [`infra/cloudflare/media-cors.json.example`](../../infra/cloudflare/media-cors.json.example), set `allowed.origins` to your `INSTANCE_PUBLIC_ORIGIN` (plus any web UI origins), then:

   ```sh
   wrangler r2 bucket cors set <MEDIA_BUCKET_NAME> --file infra/cloudflare/media-cors.json
   wrangler r2 bucket cors list <MEDIA_BUCKET_NAME>
   ```

   Purge the media hostname cache after changing CORS if the domain was already live. Worker media proxy CORS is separate (`Access-Control-Allow-Origin: *` on `/media/*` and object-key routes).

9. Set optional Worker var `CORS_ALLOWED_ORIGINS` for extra browser API origins (comma-separated). `/api*` always allows `INSTANCE_PUBLIC_ORIGIN`.
10. `pnpm run ci`
11. `pnpm run deploy` (`void deploy --backend cloudflare` in `packages/worker`). Void checks that every binding the source needs is in `wrangler.jsonc` with a real id and that the queue exists, builds (the Worker and its client, Mastodon's web UI from `packages/worker/src`, fetching upstream's emoji on the first build; see [Web UI](../reference/configuration.md#web-ui)), warns about secret-looking plaintext vars, validates `packages/worker/app/db/migrations/*.sql` against what wrangler would apply, applies them to remote D1 (and verifies none remain pending), then runs `wrangler deploy` on the verified build. The upload carries the generated entry, cron triggers from `packages/worker/app/crons`, and the queue consumers from `packages/worker/app/queues`: `tstodon-outbox-process` with `dead_letter_queue = tstodon-outbox-dlq` (its `deadLetterQueue` export, which `queueConsumerOptions` in `packages/worker/void-plugins.ts` writes; Void has no option for it), and `tstodon-outbox-dlq`, whose consumer stores dead jobs in D1. Both queues must exist before the deploy. Run `pnpm -C packages/worker exec void deploy --backend cloudflare --provision` once on a dev machine to create missing D1 / R2 / Queue resources and write their ids; `--provision` is refused in CI. The managed `void deploy` (Void platform) does not fit this Worker: it ignores `wrangler.jsonc` and cannot carry the Workflow, `StreamHub`, Analytics Engine, or Images bindings.
12. Rate limits are on by default with Mastodon's numbers (see [Rate limits](../reference/configuration.md#rate-limits)). Their counters are the `RateLimitCounter` Durable Object (`RATE_LIMIT_COUNTER`, migration tag `v2` in `wrangler.jsonc`), which `wrangler deploy` creates; there is nothing to provision. Set `RATE_LIMITS` to change a bucket, and add the [edge rule](#rate-limiting-at-the-edge) below as an outer layer.
13. Re-apply Terraform with `attach_queue_consumer = true` so both Queue consumers point at the deployed Worker. `wrangler deploy` writes the same consumers, so keep the Terraform settings equal to the queue files: `queue_consumer_batch_size`, `queue_consumer_max_retries`, `queue_consumer_max_concurrency` (default `1`) and `queue_consumer_max_wait_time_ms` to `maxBatchSize`, `maxRetries`, `maxConcurrency` and `maxBatchTimeout` in `packages/worker/app/queues/tstodon-outbox-process.ts`; `dlq_consumer_batch_size`, `dlq_consumer_max_retries` and `dlq_consumer_max_wait_time_ms` to those in `tstodon-outbox-dlq.ts`; and `outbox_dlq_name` to its `deadLetterQueue`. On an existing deployment, apply Terraform (step 1) to create `tstodon-outbox-dlq` before deploying this version (or let `void deploy --provision` create it). Inspecting and requeueing dead jobs is in the runbook ([Dead-lettered jobs](./runbook.md#dead-lettered-jobs)).

Never commit `BETTER_AUTH_SECRET`, VAPID keys, or other private key material. Confirm the Worker placement region still matches the D1 primary.

Then verify the deployment end to end with the [launch checklist](./launch-checklist.md) (Access paths, sign-in, media, push, rate limits, crons, backups, a federation smoke test). Backups, monitoring, incident playbooks and upgrades are the [operations runbook](./runbook.md).

## Moving attachments off id-derived keys

<!-- constrained-by ../reference/configuration.md#media-public-urls -->

Before migration 0103, an attachment was stored at `attachments/<accountId>/<mediaId>`. The account id is public and a media id is its upload millisecond plus 16 random bits, so anyone who knows roughly when an attachment was uploaded can find it on the public media hostname, even on a direct post. New uploads get a random 128-bit name.

The `RekeyLegacyMedia` queue job finds every row whose `object_key` is still the id-derived key. It matches on the key itself, so it also finds rows that the previous Worker wrote while the deploy rolled out. You do not need to start the job: the hourly cron queues it, and a full batch of 50 queues the batch after it at once. For each row it does these steps:

1. Copy the object to a new random key, with its HTTP and custom metadata.
2. Point the row's `object_key` at the copy and keep the old key in `legacy_object_key`. In the same D1 batch, replace the old key with the new one in the row's status's edit history. API documents, ActivityPub notes, `GET /media/:id`, and `/history` use the new URL from then on.
3. Only when `MEDIA_REKEY_DELETE_LEGACY` is on: confirm that the copy is stored, delete the object at the old key, and clear `legacy_object_key`.

Deleting a stored object cannot be undone, so step 3 is off by default. While it is off, the old object stays in the bucket and **the old, guessable URL stays reachable on the public media hostname**. The move only stops new links from using it. The old URL stops answering only after you turn the flag on, the job deletes the object, and you purge the CDN cache.

The job never deletes an old object before the row points at a copy that is stored. Each row's next step follows from its key columns, so a run that stops part way is finished by the next run. A row that fails is logged as `LegacyMediaNotRekeyed` and skipped, and the next hourly run tries it again. If D1 fails after the update in step 2 may have applied, the job keeps the copy. At worst that leaves an unused object at a random key, which nobody can find by guessing, and an account purge deletes it with everything else under `attachments/<accountId>/`. While an object is still at its old key, the Worker's `/attachments/*` route serves it without the edge cache.

After you deploy:

1. Wait until no row is at its old key:

   ```sh
   wrangler d1 execute <D1_DATABASE_NAME> --remote --command \
     "SELECT COUNT(*) FROM media_attachments WHERE object_key = 'attachments/' || account_id || '/' || id"
   ```

   A count that stays above zero for more than an hour means the job keeps failing on some rows. Read the `outbox.job.page` metric for `RekeyLegacyMedia` and the `LegacyMediaNotRekeyed` lines in the Worker logs.

2. To make the old URLs stop answering, set `MEDIA_REKEY_DELETE_LEGACY` to `true` (for example under `vars` in `wrangler.jsonc`) and deploy. Then wait until no old object is left:

   ```sh
   wrangler d1 execute <D1_DATABASE_NAME> --remote \
     --command "SELECT COUNT(*) FROM media_attachments WHERE legacy_object_key IS NOT NULL"
   ```

3. Purge the old URLs from the CDN cache of the media hostname. A deleted object can still be served from cache until then. Purge by prefix `<media hostname>/attachments/` in the dashboard (Caching, Configuration, Custom Purge), or select Purge Everything for the media zone. Do the same for the Worker hostname if `MEDIA_PUBLIC_BASE_URL` was the Worker origin.

`DELETE /api/v1/media/:id` and account purges delete an old object that is still stored, whatever the flag says. Remote servers that copied an attachment's old URL keep their own copy; Mastodon stores remote media locally when a post arrives. An old URL that a remote server fetches after the old object is deleted answers 404. A status federated while its media was still at the old key (a post, edit or poll update, or a fetch of the note, between the deploy and the move) carries the old URL, and a remote tstodon server keeps that URL instead of a copy, so the media breaks there once `MEDIA_REKEY_DELETE_LEGACY` deletes the old object. Mastodon remotes downloaded the file and are not affected.

## Stripping metadata from stored media

<!-- constrained-by ../reference/configuration.md#media-metadata -->

Uploads have been stored without their metadata since stripping on upload landed (#87, #88; see [Media metadata](../reference/configuration.md#media-metadata)). Objects stored before that still carry it: a photo's EXIF GPS position, camera and owner, its XMP and IPTC, a video's QuickTime location and device atoms. Migration 0119 adds the marks that say which stored objects are clean (`media_attachments.metadata_stripped_at`, `account_profiles.avatar_metadata_stripped_at` / `header_metadata_stripped_at`), and the `StripStoredMediaMetadata` queue job rewrites the older objects in place.

You do not need to start the job: the six-hourly cron queues its first page. Each page lists 10 unmarked rows in id order, reads each object from `MEDIA`, rewrites it with the same stripper as an upload (`StoredMediaMetadata.strip`, over `ImageMetadata` / `VideoMetadata`) and marks the row; a page with work after it queues the next page at once, with its cursor (`source`, `afterId`) and the counts so far in the message. It walks attachment originals (and the id-derived copy the rekey job keeps while `MEDIA_REKEY_DELETE_LEGACY` is off), then avatars, then headers. Previews are not read: every preview is a WebP the `IMAGES` binding encoded from an original that was already stripped (previews and stripping landed together). New uploads are marked when they are stored, so the job never reads them.

- **Idempotent.** An object whose rewrite is byte for byte what is stored (already clean, or a GIF, which is not stripped) is marked without a write. The write goes to the same key only if the object is still the one read (R2 `etagMatches`), with its content type. A run that stops part way is finished by the next, and a second chain (a cron firing while a long first run is still going) only repeats reads.
- **Bounded.** A page reads at most 64 MiB; once that is spent the remaining rows go to the next page. An object over 32 MiB is not read: the object and its rewrite are both held in memory, and a Worker has 128 MB. Every image fits (the upload cap is 16 MiB); a video over 32 MiB (the cap is 99 MiB) keeps its metadata and its row gets `metadata_strip_error` `TooLarge: <bytes> bytes`.
- **Nothing is deleted.** An object whose container cannot be walked (truncated, corrupt) is left as it is, its row gets the reason in `*_metadata_strip_error` (for example `MalformedImage: ...`), and the job passes over it from then on. A row whose object is missing from the bucket is marked clean. A read or write that fails leaves the row unmarked for the next run. Each such object is logged as `MediaMetadataNotStripped` (with `outcome`), and the last page of a run that did anything logs `MediaMetadataBackfillDone` with the counts: `stripped`, `unchanged`, `missing`, `unreadable`, `tooLarge`, `deferred`.

After you deploy:

1. Within six hours (or at once, see below), wait until nothing is left:

   ```sh
   wrangler d1 execute <D1_DATABASE_NAME> --remote --command \
     "SELECT (SELECT COUNT(*) FROM media_attachments WHERE metadata_stripped_at IS NULL AND metadata_strip_error IS NULL) AS attachments,
             (SELECT COUNT(*) FROM account_profiles WHERE avatar_object_key IS NOT NULL AND avatar_metadata_stripped_at IS NULL AND avatar_metadata_strip_error IS NULL) AS avatars,
             (SELECT COUNT(*) FROM account_profiles WHERE header_object_key IS NOT NULL AND header_metadata_stripped_at IS NULL AND header_metadata_strip_error IS NULL) AS headers"
   ```

   Progress shows in the `outbox.job.page` metric for `StripStoredMediaMetadata` (the step is the source).

2. List what was passed over, and decide what to do with it (replace or delete it through the owner's account):

   ```sh
   wrangler d1 execute <D1_DATABASE_NAME> --remote --command \
     "SELECT id, object_key, metadata_strip_error FROM media_attachments WHERE metadata_strip_error IS NOT NULL"
   ```

   Clearing a row's `metadata_strip_error` makes the next run try it again.

To start a run without waiting for the cron, send the queue a message, for example with the Queues REST API (an API token allowed to write to Queues):

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/queues/<QUEUE_ID>/messages" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  --data '{"body": {"kind": "StripStoredMediaMetadata"}, "content_type": "json"}'
```

Starting it again, at any time, is safe: once every row is marked, a run is one page that reads no object.

**Caches keep the old bytes.** The rewrite keeps the key, so the URL does not change, and media is served with `Cache-Control: public, max-age=31536000, immutable`. Browsers, the media hostname's CDN cache and remote servers that copied the file keep the version with metadata until it expires or they fetch it again. The job drops the copy in the Worker's own Cache API (`caches.default`), which only matters when `MEDIA_PUBLIC_BASE_URL` is the Worker origin, and only reaches the data centre the queue consumer ran in. The Worker cannot purge the zone cache (that needs an API token it does not have). After the run, purge the media hostname: by prefix `<media hostname>/attachments/`, `/avatars/` and `/headers/` in the dashboard (Caching, Configuration, Custom Purge), or Purge Everything for the media zone; do the same for the Worker hostname if `MEDIA_PUBLIC_BASE_URL` is the Worker origin. Copies already in browsers and on remote servers cannot be recalled.

## Recording stored media sizes

<!-- constrained-by ../reference/configuration.md#media-storage-accounting -->

Migration 0125 adds the byte size of each stored object (see [Media storage accounting](../reference/configuration.md#media-storage-accounting)). Uploads, avatar and header changes, custom emoji uploads and the metadata rewrite record sizes from then on; rows stored before have no size (NULL) and count 0 in `space_usage`, `instance_media_attachments` and the export page until the `BackfillStoredMediaSizes` queue job has read them.

You do not need to start the job: the six-hourly cron queues its first page on `tstodon-outbox-process`. Each page is one D1 query (`listUnsizedMedia`) for up to 50 rows of unknown size, attachments first, then avatars, headers and custom emojis; each object gets a `HEAD` (its size from R2's metadata, no body read), and the row records the size only while it still holds that key and its size is still unknown, so an upload or metadata rewrite since is never overwritten. A full page queues the next one with its cursor (`source`, `afterId`) and the counts so far.

- **Missing objects.** A row whose object is not in the bucket gets size 0 and a `MediaSizeNotRead` warning with the key and `outcome` `Missing`.
- **Failures.** A `HEAD` or D1 write that fails is logged as `MediaSizeNotRead` (`Deferred`) and leaves the row's size unknown for the next run.
- **Done.** The last page of a run that did anything logs `MediaSizeBackfillDone` with `sized`, `missing` and `deferred`. Once every size is known, a run is one query that reads nothing (partial indexes on the unknown sizes) and no `HEAD`.

To check progress:

```sh
wrangler d1 execute <D1_DATABASE_NAME> --remote --command \
  "SELECT (SELECT COUNT(*) FROM media_attachments WHERE file_size IS NULL OR (preview_object_key IS NOT NULL AND preview_file_size IS NULL)) AS attachments,
          (SELECT COUNT(*) FROM account_profiles WHERE (avatar_object_key IS NOT NULL AND avatar_file_size IS NULL) OR (header_object_key IS NOT NULL AND header_file_size IS NULL)) AS profiles,
          (SELECT COUNT(*) FROM custom_emojis WHERE image_file_size IS NULL) AS emojis"
```

Progress also shows in the `outbox.job.page` metric for `BackfillStoredMediaSizes` (the step is the source). To start a run at once, send the queue `{"kind": "BackfillStoredMediaSizes"}` as for the metadata job above; starting it again is always safe.

## Rate limiting at the edge

<!-- constrained-by ../reference/configuration.md#rate-limits -->

The Worker's limits are per subject and Mastodon-shaped, and each counted request is a Durable Object call. A Cloudflare WAF rate-limiting rule drops a flood before it reaches the Worker, at no Worker cost, so put one in front as an outer layer. Keep it well above the Worker's own budgets so that it only ever catches floods: a client within Mastodon's limits must never meet it.

In the dashboard: the zone, **Security** → **WAF** → **Rate limiting rules** → **Create rule** (the Free plan has one rule, a 10-second period and a 10-second block; paid plans allow longer):

- **If incoming requests match** (expression editor):

  ```text
  (http.request.uri.path wildcard "/api/*"
   or http.request.uri.path wildcard "/oauth/*"
   or http.request.uri.path wildcard "/auth/*"
   or http.request.uri.path wildcard "/.well-known/*"
   or http.request.uri.path wildcard "/users/*"
   or http.request.uri.path eq "/inbox"
   or http.request.uri.path eq "/actor/inbox")
  and not http.request.uri.path wildcard "/api/v1/streaming*"
  ```

- **With the same characteristics**: IP.
- **When rate exceeds**: 200 requests per 10 seconds.
- **Then take action**: Block, for 10 seconds (on a paid plan, a custom JSON response `{"error":"Too many requests"}` with status 429 matches what the Worker sends). Do not use a challenge: API clients and remote servers cannot solve one.

Remote servers deliver from a few addresses and retry a refused delivery later, so a 10-second block costs them only a delay; still, if a large server that many of your users follow is caught by the rule, raise the rate or exclude the inbox paths from it and leave them to `inbox_ip` / `inbox_domain`.
