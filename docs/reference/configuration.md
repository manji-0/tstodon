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

## Federation path policy (ops)

<!-- constrained-by ../operations/cloudflare-deploy.md -->

Access application policies must **bypass** public federation and discovery paths so remote servers can reach the instance without an Access login. At minimum allow unauthenticated access to `/.well-known/*`, `/nodeinfo/*`, `/users/*`, and ActivityPub inbox/outbox surfaces. Require Access for `/api/*` (and any private UI).

Automate this with Terraform under [`infra/cloudflare-access`](../../infra/cloudflare-access/README.md): it creates the WorkOS OIDC IdP, an Allow app for `/api*`, and Bypass apps for federation/health paths, then outputs `CF_ACCESS_*` Worker vars.
