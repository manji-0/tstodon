# Configuration Reference

## Cloudflare bindings

<!-- constrained-by ../architecture/tstodon-architecture.md#cloudflare-mapping -->

Configured in `wrangler.jsonc`:

- `DB` — D1
- `MEDIA` — R2
- `REMOTE_DNS_CACHE`, `APP_CACHE` — KV
- `OUTBOX_PROCESS_QUEUE` — Queue producer/consumer (`ExpandFollowers` fan-out and `ProcessExpiredPolls`)
- `STREAM_HUB` — Durable Object
- `OUTBOX_DELIVERY_WORKFLOW` — per-inbox delivery retries
- `IMAGES` — Images
- `METRICS` — Analytics Engine
- `ASSETS` — static assets

Placeholder resource IDs in `wrangler.jsonc` are local-only. Create real D1 / KV / R2 resources before deploying.

## Instance vars

`INSTANCE_DOMAIN`, `INSTANCE_NAME`, `INSTANCE_DESCRIPTION`, `SOURCE_URL`, `INSTANCE_LANGUAGES`, `CONTACT_EMAIL`, `INSTANCE_THUMBNAIL_URL`, and `MEDIA_PUBLIC_BASE_URL` are public configuration.

## WorkOS authentication vars

<!-- constrained-by ../planning/local-core.md#authentication -->

`WORKOS_CLIENT_ID`, `WORKOS_AUDIENCE`, `WORKOS_ISSUER`, and `WORKOS_AUTHKIT_DOMAIN` are configuration, not secrets. `WORKOS_API_KEY` is a secret: keep it out of git. Use `.dev.vars` locally and `wrangler secret put WORKOS_API_KEY` in production.

The Worker verifies AuthKit access tokens against `https://api.workos.com/sso/jwks/${WORKOS_CLIENT_ID}` using `jose`. Default issuer is `https://api.workos.com`. `WORKOS_AUDIENCE` must match the JWT template `aud` claim (`https://example.com/api` locally). The environment JWT template adds `email` from `{{ user.email }}` and copies user metadata onto claim `fedi`. The Worker reads `fedi["fedi/role"]` (`admin` or `user`; missing or unknown values are `{ kind: "User" }`) and treats `admin` as `{ kind: "Admin" }` for `requireAdmin`. WorkOS Liquid cannot index a slash key, so the template interpolates the whole metadata object instead of `user.metadata['fedi/role']`. `WORKOS_API_KEY` remains the fallback if `email` is absent, and then reads the same metadata key from the user object.

Current template (WorkOS `PUT /user_management/jwt_template`):

```json
{
  "aud": "https://example.com/api",
  "email": {{ user.email }},
  "fedi": {{ user.metadata }}
}
```

`GET /login` starts the AuthKit authorization code flow when `WORKOS_CLIENT_ID` is set. If `WORKOS_AUTHKIT_DOMAIN` is set, `/login` redirects there instead.

## Local development bearer

`DEV_BEARER_SECRET` is a local-only shared secret. Clients authenticate as `Authorization: Bearer ${DEV_BEARER_SECRET}:${email}` (role `user`) or `Authorization: Bearer ${DEV_BEARER_SECRET}:${email}:admin`. The Worker creates a local account from the e-mail local-part on first request. An empty or unset secret skips this shortcut so WorkOS JWTs can be the only bearer path. Override the wrangler default with `.dev.vars` or `wrangler secret put DEV_BEARER_SECRET`. Production should use WorkOS instead of this bearer.
