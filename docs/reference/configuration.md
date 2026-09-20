# Configuration Reference

## Cloudflare bindings
<!-- constrained-by ../architecture/tstodon-architecture.md#cloudflare-mapping -->

Configured in `wrangler.jsonc`:

- `DB` — D1
- `MEDIA` — R2
- `REMOTE_DNS_CACHE`, `APP_CACHE` — KV
- `OUTBOX_PROCESS_QUEUE` — Queue producer/consumer
- `STREAM_HUB` — Durable Object
- `OUTBOX_DELIVERY_WORKFLOW` — Workflow
- `IMAGES` — Images
- `METRICS` — Analytics Engine
- `ASSETS` — static assets

Placeholder resource IDs in `wrangler.jsonc` are local-only. Create real D1 / KV / R2 resources before deploying.

## Instance vars

`INSTANCE_DOMAIN`, `INSTANCE_NAME`, `INSTANCE_DESCRIPTION`, `SOURCE_URL`, `INSTANCE_LANGUAGES`, `CONTACT_EMAIL`, `INSTANCE_THUMBNAIL_URL`, and `MEDIA_PUBLIC_BASE_URL` are public configuration.

## Auth0 authentication vars

`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`, `AUTH0_EMAIL_CLAIM`, and `AUTH0_ADMIN_ROLES` are configuration, not secrets. Keep client secrets and private keys out of git. Use `.dev.vars` locally and `wrangler secret put` in production.

## Local development bearer

`DEV_BEARER_SECRET` is a local-only shared secret. Clients authenticate as `Authorization: Bearer ${DEV_BEARER_SECRET}:${email}`. The Worker creates a local account from the e-mail local-part on first request. An empty or unset secret rejects every bearer token. Override the wrangler default with `.dev.vars` or `wrangler secret put DEV_BEARER_SECRET`. Production should use Auth0 instead of this bearer.
