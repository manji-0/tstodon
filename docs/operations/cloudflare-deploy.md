# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

1. Provision Cloudflare resources with [`infra/cloudflare`](../../infra/cloudflare/README.md) (`tofu apply`): D1, KV, R2, Queue.
2. Copy `tofu output -json wrangler_bindings` into production `packages/worker/wrangler.jsonc`, and pin the account there (`account_id`) or export `CLOUDFLARE_ACCOUNT_ID` (replace placeholder D1 / KV / R2 / queue identifiers).
3. Put the Better Auth signing secret, once: `openssl rand -base64 32 | wrangler secret put BETTER_AUTH_SECRET` (see [Authentication](../reference/configuration.md#authentication)). Without it every request fails. Set `ADMIN_USERNAMES` to the username you will sign up with first, and `REGISTRATIONS_OPEN` / `REGISTRATION_APPROVAL` as wanted. Sign-up mails a confirmation link: onboard the `EMAIL_FROM` domain for sending in Cloudflare Email Service (the `EMAIL` send_email binding) and keep `EMAIL_TRANSPORT=send_email`.
4. Serve the Worker directly on its hostname: sign-in and OAuth are the Worker's own, so no Cloudflare Access application should sit in front of `/api*`, `/oauth/*`, or `/auth/*`.
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
11. `pnpm run deploy` (`void deploy --backend cloudflare` in `packages/worker`). Void checks that every binding the source needs is in `wrangler.jsonc` with a real id and that the queue exists, builds, warns about secret-looking plaintext vars, validates `packages/worker/app/db/migrations/*.sql` against what wrangler would apply, applies them to remote D1 (and verifies none remain pending), then runs `wrangler deploy` on the verified build. The upload carries the generated entry, cron triggers from `packages/worker/app/crons`, and the queue consumer from `packages/worker/app/queues`. Run `pnpm -C packages/worker exec void deploy --backend cloudflare --provision` once on a dev machine to create missing D1 / KV / R2 / Queue resources and write their ids; `--provision` is refused in CI. The managed `void deploy` (Void platform) does not fit this Worker: it ignores `wrangler.jsonc` and cannot carry the Workflow, `StreamHub`, Analytics Engine, or Images bindings.
12. Re-apply Terraform with `attach_queue_consumer = true` so the outbox Queue consumer points at the deployed Worker. Keep `queue_consumer_max_concurrency` (default `1`) equal to `maxConcurrency` in `packages/worker/app/queues/tstodon-outbox-process.ts`; `wrangler deploy` writes that value too.

Never commit `BETTER_AUTH_SECRET`, VAPID keys, or other private key material. Confirm the Worker placement region still matches the D1 primary.

## Moving attachments off id-derived keys

<!-- constrained-by ../reference/configuration.md#media-public-urls -->

Before migration 0102, an attachment was stored at `attachments/<accountId>/<mediaId>`. The account id is public and a media id is its upload millisecond plus 16 random bits, so anyone who knows roughly when an attachment was uploaded can find it on the public media hostname, even on a direct post. New uploads get a random 128-bit name. Migration 0102 marks every row still at the old key in `media_attachments.legacy_object_key`.

The `RekeyLegacyMedia` queue job moves the marked rows. You do not need to start it: the hourly cron queues it, and a full batch of 50 that made progress queues the next batch at once. For each row it does these steps:

1. Copy the object to a new random key.
2. Point the row's `object_key` at the copy. API documents, ActivityPub notes, and `GET /media/:id` use the new URL from then on.
3. Delete the object at the old key, then clear `legacy_object_key`.

The job never deletes the old object before the row points at a stored copy. Each row's next step follows from its two key columns, so a run that stops part way is finished by the next run. A run that stops between steps 1 and 2 can leave one unused copy at a random key; it is not reachable by guessing. While an object is still at its old key, the Worker's `/attachments/*` route serves it without the edge cache, so it stops answering once it is deleted.

After you deploy:

1. Wait until no marked rows remain:

   ```sh
   wrangler d1 execute <D1_DATABASE_NAME> --remote \
     --command "SELECT COUNT(*) FROM media_attachments WHERE legacy_object_key IS NOT NULL"
   ```

   A count that stays above zero for more than an hour means the job keeps failing on some rows; read the `outbox.job.page` metric for `RekeyLegacyMedia` and the Worker logs.

2. Purge the old URLs from the CDN cache of the media hostname. A deleted object can still be served from cache until then. Purge by prefix `<media hostname>/attachments/` in the dashboard (Caching, Configuration, Custom Purge), or select Purge Everything for the media zone. Do the same for the Worker hostname if `MEDIA_PUBLIC_BASE_URL` was the Worker origin.

Remote servers that copied an attachment's old URL keep their own copy; Mastodon stores remote media locally when a post arrives. An old URL that a remote server fetches after the move answers 404.
