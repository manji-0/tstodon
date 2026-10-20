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

Placeholder resource IDs in `wrangler.jsonc` are local-only. Create real D1 / KV / R2 / Queue resources with [`infra/cloudflare`](../../infra/cloudflare/README.md) before deploying (`tofu output -json wrangler_bindings`).

## Instance vars

`INSTANCE_THUMBNAIL_DESCRIPTION` is the optional caption for the instance thumbnail. `INSTANCE_DOMAIN`, `INSTANCE_NAME`, `INSTANCE_DESCRIPTION`, `SOURCE_URL`, `INSTANCE_LANGUAGES`, `CONTACT_EMAIL`, `INSTANCE_THUMBNAIL_URL`, and `MEDIA_PUBLIC_BASE_URL` are public configuration. `REGISTRATION_APPROVAL` (a truthy string) makes a newly provisioned local account wait for approval: it is reported as `approved: false` and `registrations.approval_required: true` in `/api/v2/instance`, it stays out of search, the directory, and trends, and an admin either approves it (`POST /api/v1/admin/accounts/:id/approve`) or rejects it, which deletes the account. `INSTANCE_RULES` is a JSON array of strings (or `{ "text": ..., "hint": ... }` objects) served by `GET /api/v1/instance/rules` and the v2 instance document. `CUSTOM_EMOJIS` is a JSON array of `{ "shortcode": ..., "url": ..., "static_url"?: ..., "visible_in_picker"?: ..., "category"?: ... }` served by `GET /api/v1/custom_emojis` and attached to documents whose text uses the shortcode. Admins can additionally manage emojis at `/api/v1/admin/custom_emojis` (multipart `shortcode` + `image`), which are stored in the media bucket under `emoji/` and merged over the var. `INSTANCE_EXTENDED_DESCRIPTION` and `INSTANCE_PRIVACY_POLICY` are JSON objects (`{ "content": "<p>...</p>", "updated_at"?: "..." }`), and `INSTANCE_TERMS_OF_SERVICE` is a JSON object (`{ "content": "<p>...</p>", "effective_date": "YYYY-MM-DD" }`); each is served by its `GET /api/v1/instance/...` endpoint and 404s when unset. `ANNOUNCEMENTS` is a JSON array of Mastodon announcement objects (`{ "id": ..., "content": ..., "starts_at"?: ..., "ends_at"?: ..., "all_day"?: ..., "published_at"?: ..., "updated_at"?: ..., "reactions"?: [...] }`) served by `GET /api/v1/announcements`; dismissals and reactions are stored per account. Admins can also author announcements at `/api/v1/admin/announcements`, which are stored in D1 and merged over the var.

## Cloudflare Access authentication vars

<!-- constrained-by ../planning/local-core.md#authentication -->

Production authentication is **Cloudflare Access**. WorkOS is the **Access identity provider** (OIDC/SAML in Zero Trust), not a direct Worker dependency.

| Var                           | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `CF_ACCESS_TEAM_DOMAIN`       | Team domain, e.g. `https://<team>.cloudflareaccess.com` (issuer)                     |
| `CF_ACCESS_AUD`               | Access application audience (AUD) tag                                                |
| `CF_ACCESS_ADMIN_GROUPS`      | Comma-separated Access/IdP group names that map to `{ kind: "Admin" }`               |
| `CF_ACCESS_JWKS_URL`          | Optional JWKS URL override (empty ⇒ `${CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`) |
| `CF_ACCESS_JWKS_JSON`         | Optional inline JWKS JSON for local/tests                                            |
| `CF_ACCESS_LOCAL_PRIVATE_JWK` | Optional local-only private JWK so `/oauth/token` can mint Access-shaped JWTs        |

The Worker verifies Access JWTs with `jose` from either:

1. `Cf-Access-Jwt-Assertion`
2. `Authorization: Bearer <Access JWT>` (interim Mastodon API client path)

Claims used: `email` (required for account provisioning), plus `groups` and/or `custom.groups` for admin mapping via `CF_ACCESS_ADMIN_GROUPS`. Missing email ⇒ `InvalidToken`.

Do not commit production AUD values, private JWKs, or Access secrets. Local `wrangler.jsonc` may contain the test fixture JWKS/private JWK under `packages/worker/test/access-jwt-fixture.ts`.

## Local development authentication

<!-- derived-from #cloudflare-access-authentication-vars -->

Tests mint Access-shaped JWTs with the fixture RSA keypair (`packages/worker/test/access-jwt-fixture.ts`) and present them as Bearer tokens (or `Cf-Access-Jwt-Assertion`). Admin tests include the configured admin group claim. There is no `DEV_BEARER_SECRET` shortcut.

`GET /login` explains that Access handles sign-in. `/oauth/token` mints a short-lived Access JWT only when `CF_ACCESS_LOCAL_PRIVATE_JWK` is set (local fixture).

## Limited federation

`FEDERATION_ALLOW_HOSTS` is a comma-separated list of the only hosts allowed to federate. A non-empty list (or a runtime `domain_allows` row, managed at `/api/v1/admin/domain_allows`) turns on limited federation: outbound fetches and delivery, inbound inbox activities, and link unfurling refuse any other host, `GET /api/v1/instance/peers` and `/api/v1/instance/activity` require a user token, and `/api/v2/instance` reports `limited_federation: true`. Listed hosts also keep the private-IP exemption used by local e2e setups (`127.0.0.1`).

## Federation path policy (ops)

<!-- constrained-by ../operations/cloudflare-deploy.md -->

Access application policies must **bypass** public federation and discovery paths so remote servers can reach the instance without an Access login. At minimum allow unauthenticated access to `/.well-known/*`, `/nodeinfo/*`, `/users/*`, and ActivityPub inbox/outbox surfaces. Require Access for `/api/*` (and any private UI).

Automate this with Terraform under [`infra/cloudflare`](../../infra/cloudflare/README.md): it creates D1 / KV / R2 / Queue plus the WorkOS OIDC IdP, an Allow app for `/api*`, and Bypass apps for federation/health paths, then outputs `wrangler_bindings` and `CF_ACCESS_*` Worker vars.
