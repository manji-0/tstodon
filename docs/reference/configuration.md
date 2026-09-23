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

`INSTANCE_DOMAIN`, `INSTANCE_NAME`, `INSTANCE_DESCRIPTION`, `SOURCE_URL`, `INSTANCE_LANGUAGES`, `CONTACT_EMAIL`, `INSTANCE_THUMBNAIL_URL`, and `MEDIA_PUBLIC_BASE_URL` are public configuration.

### Media public URLs

<!-- constrained-by ../operations/cloudflare-deploy.md -->

Media blobs live in the `MEDIA` R2 bucket. Public Mastodon JSON emits absolute URLs as `${MEDIA_PUBLIC_BASE_URL}/${objectKey}` (no Worker hop in production). Unattached uploads and restricted-visibility attachments emit Worker-gated `${INSTANCE_PUBLIC_ORIGIN}/media/:id` URLs instead.

| Environment   | `MEDIA_PUBLIC_BASE_URL`                                       | How bytes are served                                                                         |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Production    | R2 custom domain (e.g. `https://media.example.com`)           | R2 public hostname for public keys; Worker `/media/:id` for private attachments              |
| Local / tests | Same as `INSTANCE_PUBLIC_ORIGIN` (e.g. `https://example.com`) | Worker object-key proxy (`/attachments/*`, `/avatars/*`, `/headers/*`) plus `GET /media/:id` |

Object keys:

- Public attachments / previews: `attachments/{accountId}/{mediaId}`, `attachments/{accountId}/{mediaId}/preview`
- Private (unattached or restricted visibility): `private/attachments/{accountId}/{mediaId}` (+ `/preview`)
- Avatars / headers: `avatars/{accountId}/{blobId}`, `headers/{accountId}/{blobId}`

Uploads accept `image/jpeg`, `image/png`, and `image/webp` up to 8 MiB. The `IMAGES` binding builds a WebP preview and dimension meta on upload when available; blurhash stays `null` until a pixel-decode path exists. Attaching media to a Public/Unlisted status promotes private object keys onto the public prefix.

Do not expose `private/` keys on the R2 custom domain (or treat them as guessable). Prefer Worker-gated `/media/:id` for anything with `is_private = 1`.

### CORS / allowed origins

<!-- constrained-by ../operations/cloudflare-deploy.md -->

| Surface                                                                       | Behavior                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker media proxy (`/media/*`, `/attachments/*`, `/avatars/*`, `/headers/*`) | `Access-Control-Allow-Origin: *` (GET/HEAD/OPTIONS; no credentials)                                                                                                                          |
| Worker `/api/*`                                                               | Reflect `Origin` only when it matches `INSTANCE_PUBLIC_ORIGIN` or an entry in `CORS_ALLOWED_ORIGINS` (comma-separated). Allows `Authorization`, `Content-Type`, `Cf-Access-Jwt-Assertion`.   |
| Production R2 custom domain                                                   | Apply a bucket CORS policy (see [`infra/cloudflare/media-cors.json.example`](../../infra/cloudflare/media-cors.json.example) and deploy checklist). Worker CORS does not cover R2 hostnames. |

`CORS_ALLOWED_ORIGINS` is optional. Empty ⇒ API CORS still allows the instance public origin. Trailing slashes are normalized.

Optional catalog vars (empty ⇒ empty API arrays):

| Var                      | Purpose                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `INSTANCE_RULES`         | JSON array of `{id?, text}` / strings, or newline-separated rule texts for `/api/v1/instance/rules` |
| `INSTANCE_CUSTOM_EMOJIS` | JSON array of `{shortcode, url, static_url?, visible_in_picker?, category?}`                        |
| `INSTANCE_ANNOUNCEMENTS` | JSON array of `{id, content, published_at?, updated_at?, starts_at?, ends_at?, all_day?}`           |

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

Automate this with Terraform under [`infra/cloudflare`](../../infra/cloudflare/README.md): it creates D1 / KV / R2 / Queue plus the WorkOS OIDC IdP, an Allow app for `/api*`, and Bypass apps for federation/health paths, then outputs `wrangler_bindings` and `CF_ACCESS_*` Worker vars.
