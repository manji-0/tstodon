# Configuration Reference

## Cloudflare bindings

<!-- constrained-by ../architecture/tstodon-architecture.md#cloudflare-mapping -->

Configured in `packages/worker/wrangler.jsonc`:

- `DB` — D1
- `MEDIA` — R2
- `REMOTE_DNS_CACHE`, `APP_CACHE` — KV
- `OUTBOX_PROCESS_QUEUE` — Queue producer/consumer (`ExpandFollowers` fan-out and `ProcessExpiredPolls`)
- `STREAM_HUB` — Durable Object
- `OUTBOX_DELIVERY_WORKFLOW` — per-inbox delivery retries
- `IMAGES` — Images
- `METRICS` — Analytics Engine
- `ASSETS` — static assets

Placeholder resource IDs in `packages/worker/wrangler.jsonc` are local-only. Create real D1 / KV / R2 / Queue resources with [`infra/cloudflare`](../../infra/cloudflare/README.md) before deploying (`tofu output -json wrangler_bindings`).

## Instance vars

`INSTANCE_THUMBNAIL_DESCRIPTION` is the optional caption for the instance thumbnail. `INSTANCE_DOMAIN`, `INSTANCE_NAME`, `INSTANCE_DESCRIPTION`, `SOURCE_URL`, `INSTANCE_LANGUAGES`, `CONTACT_EMAIL`, `INSTANCE_THUMBNAIL_URL`, and `MEDIA_PUBLIC_BASE_URL` are public configuration. `REGISTRATION_APPROVAL` (a truthy string) makes a newly provisioned local account wait for approval: it is reported as `approved: false` and `registrations.approval_required: true` in `/api/v2/instance`, it stays out of search, the directory, and trends, and an admin either approves it (`POST /api/v1/admin/accounts/:id/approve`) or rejects it, which deletes the account. `INSTANCE_RULES` is a JSON array of strings (or `{ "text": ..., "hint": ... }` objects) served by `GET /api/v1/instance/rules` and the v2 instance document. `CUSTOM_EMOJIS` is a JSON array of `{ "shortcode": ..., "url": ..., "static_url"?: ..., "visible_in_picker"?: ..., "category"?: ... }` served by `GET /api/v1/custom_emojis` and attached to documents whose text uses the shortcode. Admins can additionally manage emojis at `/api/v1/admin/custom_emojis` (multipart `shortcode` + `image`), which are stored in the media bucket under `emoji/` and merged over the var. `INSTANCE_EXTENDED_DESCRIPTION` and `INSTANCE_PRIVACY_POLICY` are JSON objects (`{ "content": "<p>...</p>", "updated_at"?: "..." }`), and `INSTANCE_TERMS_OF_SERVICE` is a JSON object (`{ "content": "<p>...</p>", "effective_date": "YYYY-MM-DD" }`); each is served by its `GET /api/v1/instance/...` endpoint and 404s when unset. `ANNOUNCEMENTS` is a JSON array of Mastodon announcement objects (`{ "id": ..., "content": ..., "starts_at"?: ..., "ends_at"?: ..., "all_day"?: ..., "published_at"?: ..., "updated_at"?: ..., "reactions"?: [...] }`) served by `GET /api/v1/announcements`; dismissals and reactions are stored per account. Admins can also author announcements at `/api/v1/admin/announcements`, which are stored in D1 and merged over the var.

### Media public URLs

<!-- constrained-by ../operations/cloudflare-deploy.md -->

Media blobs live in the `MEDIA` R2 bucket. Mastodon JSON emits absolute URLs as `${MEDIA_PUBLIC_BASE_URL}/${objectKey}` (no Worker hop in production).

| Environment   | `MEDIA_PUBLIC_BASE_URL`                                       | How bytes are served                                                                         |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Production    | R2 custom domain (e.g. `https://media.example.com`)           | R2 public hostname                                                                           |
| Local / tests | Same as `INSTANCE_PUBLIC_ORIGIN` (e.g. `https://example.com`) | Worker object-key proxy (`/attachments/*`, `/avatars/*`, `/headers/*`) plus `GET /media/:id` |

Object keys: `attachments/{accountId}/{mediaId}`, `avatars/{accountId}/{blobId}`, `headers/{accountId}/{blobId}`. The `IMAGES` binding is reserved for transforms; it is not used on the read path yet.

### CORS / allowed origins

<!-- constrained-by ../operations/cloudflare-deploy.md -->

| Surface                                                                       | Behavior                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker media proxy (`/media/*`, `/attachments/*`, `/avatars/*`, `/headers/*`) | `Access-Control-Allow-Origin: *` (GET/HEAD/OPTIONS; no credentials)                                                                                                                                                 |
| Worker `/api/*`                                                               | Reflect `Origin` only when it matches `INSTANCE_PUBLIC_ORIGIN` or an entry in `CORS_ALLOWED_ORIGINS` (comma-separated). Allows `Authorization`, `Content-Type`. Also applies to `/oauth/token` and `/oauth/revoke`. |
| Production R2 custom domain                                                   | Apply a bucket CORS policy (see [`infra/cloudflare/media-cors.json.example`](../../infra/cloudflare/media-cors.json.example) and deploy checklist). Worker CORS does not cover R2 hostnames.                        |

`CORS_ALLOWED_ORIGINS` is optional. Empty ⇒ API CORS still allows the instance public origin. Trailing slashes are normalized.

## Authentication

Sign-in is Void's [Better Auth](https://www.better-auth.com/) integration, configured in `packages/worker/app/auth.ts` and mounted at `/api/auth/*`. It is **passkey-only** (no passwords, no social providers) and carries the Better Auth **admin** plugin. Mastodon clients never use those sessions directly: the Worker is its own OAuth 2 authorization server and turns a signed-in session into an access token.

| Surface                                                    | Purpose                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /auth/sign_up`                                        | Choose a username and create a passkey; creates the Better Auth user and the local account together |
| `GET /auth/sign_in`                                        | Sign in with a passkey (or see who is signed in and sign out); `GET /login` redirects here          |
| `POST /api/v1/apps`, `GET /api/v1/apps/verify_credentials` | Register a client (`client_name`, `redirect_uris`, `scopes`); the secret is shown once              |
| `GET`/`POST /oauth/authorize`                              | Consent page (needs a session); `code` flow, optional PKCE (`S256`), `urn:ietf:wg:oauth:2.0:oob`    |
| `POST /oauth/token`                                        | `authorization_code` and `client_credentials` grants; client auth by body or HTTP Basic             |
| `POST /oauth/revoke`                                       | RFC 7009 revocation                                                                                 |
| `GET /.well-known/oauth-authorization-server`              | RFC 8414 metadata                                                                                   |

API requests authenticate with `Authorization: Bearer <access token>` (streaming also takes `?access_token=`). Client secrets, codes, and tokens are stored as SHA-256 digests (`oauth_applications`, `oauth_authorization_codes`, `oauth_access_tokens`). A token needs the granular scope Mastodon gives the endpoint (`read:statuses` for timelines, `write:favourites` to favourite, `admin:read:reports` for admin reports, …; the table is `SCOPE_RULES` in `packages/worker/src/oauth-scope.ts`). A top-level scope (`read`, `write`, `admin:read`, `admin:write`) covers every granular scope under it, `follow` covers `read`/`write` `:follows` / `:blocks` / `:mutes`, and `profile` allows only `GET /api/v1/accounts/verify_credentials`. Public metadata (instance, custom emojis, trends) needs no scope. Anything else is `403` with `kind: "InsufficientScope"`. Suspended and disabled accounts are refused at every token use.

| Var                     | Purpose                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`    | **Secret**, required in production: signs Better Auth cookies. Void falls back to a fixed dev secret only on `localhost` / `127.0.0.1`; without it any other host fails every request |
| `REGISTRATIONS_OPEN`    | Whether `/auth/sign_up` creates accounts (default on; `false` closes sign-up). Reported as `registrations.enabled`                                                                    |
| `REGISTRATION_APPROVAL` | New accounts wait for admin approval (see [Instance vars](#instance-vars))                                                                                                            |
| `ADMIN_USERNAMES`       | Comma-separated usernames that sign up with the Better Auth role `admin`                                                                                                              |

An account is an instance admin when its Better Auth user's `role` includes `admin`. Bootstrap the first admin with `ADMIN_USERNAMES`, or promote an existing account in D1:

```sh
pnpm -C packages/worker exec wrangler d1 execute tstodon --remote --command \
  "UPDATE \"user\" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = 'alice')"
```

After that, admins can manage roles and bans through the Better Auth admin endpoints (`/api/auth/admin/*`). The passkey step only accepts a live link token as its `context`, so no passkey (and no account) exists without a confirmed address. Username, email, and the email-domain / canonical-email sign-up blocks are checked at both steps. Intents live in `signup_intents` (token stored as a SHA-256 digest).

```sh
openssl rand -base64 32 | pnpm -C packages/worker exec wrangler secret put BETTER_AUTH_SECRET
```

## Local development authentication

<!-- derived-from #authentication -->

`pnpm dev` serves on `localhost`, where Void supplies a dev `BETTER_AUTH_SECRET`; a browser with a platform authenticator (or the Chrome DevTools WebAuthn emulator) can sign up at `/auth/sign_up`. Local `send_email` does not deliver; set `EMAIL_TRANSPORT=capture` and read the link with `wrangler kv key get --binding APP_CACHE --local "mailbox:<address>"`. Worker tests seed a Better Auth user, its account, and an OAuth token directly in D1 (`packages/worker/test/auth-fixture.ts`, `authHeaders(email, { admin })`), and `src/oauth.test.ts` drives the real sign-up (captured confirmation mail, then passkey) and OAuth endpoints with a software authenticator (`packages/worker/test/soft-passkey.ts`). The e2e instances run with `EMAIL_TRANSPORT=capture` and sign up the same way. The test runner's `BETTER_AUTH_SECRET` and `EMAIL_TRANSPORT=capture` are injected through `miniflare.bindings` in the root `vite.config.ts`.

## Web Push

`VAPID_PRIVATE_JWK` is a **secret** holding the instance's P-256 VAPID private key as a JWK (`{"kty":"EC","crv":"P-256","x":…,"y":…,"d":…}`); its public point is advertised as `vapid_key` on `/api/v1/apps`, as `configuration.vapid.public_key` on `/api/v2/instance`, and as `server_key` on push subscriptions. `VAPID_SUBJECT` is the optional `mailto:` or `https:` contact push services see in the VAPID token. Without `VAPID_PRIVATE_JWK` the instance reports `vapid_key: null`. Generate a key once and keep it: rotating it invalidates every client's subscription. Each OAuth access token holds one subscription (`/api/v1/push/subscription` reads, replaces, or deletes the token's own), revoking the token removes it, and notifications go to every subscription of the account.

```sh
node -e 'const {generateKeyPairSync}=require("crypto");console.log(JSON.stringify(generateKeyPairSync("ec",{namedCurve:"P-256"}).privateKey.export({format:"jwk"})))' \
  | pnpm exec wrangler secret put VAPID_PRIVATE_JWK
```

The test runner injects its own fixture key through `miniflare.bindings` in the root `vite.config.ts`; it is never used outside tests.

## Limited federation

`FEDERATION_ALLOW_HOSTS` is a comma-separated list of the only hosts allowed to federate. A non-empty list (or a runtime `domain_allows` row, managed at `/api/v1/admin/domain_allows`) turns on limited federation: outbound fetches and delivery, inbound inbox activities, and link unfurling refuse any other host, `GET /api/v1/instance/peers` and `/api/v1/instance/activity` require a user token, and `/api/v2/instance` reports `limited_federation: true`. Listed hosts also keep the private-IP exemption used by local e2e setups (`127.0.0.1`).
