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

| Environment   | `MEDIA_PUBLIC_BASE_URL`                                       | How bytes are served                                                   |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Production    | R2 custom domain (e.g. `https://media.example.com`)           | R2 public hostname                                                     |
| Local / tests | Same as `INSTANCE_PUBLIC_ORIGIN` (e.g. `https://example.com`) | Worker object-key proxy (`/attachments/*`, `/avatars/*`, `/headers/*`) |

Object keys: `attachments/{accountId}/{name}`, `avatars/{accountId}/{blobId}`, `headers/{accountId}/{blobId}`. An attachment's `name` is 128 random bits in hex, stored in the row's `object_key` and never derived from the media id. Both hostnames serve every object without auth, so that name is what keeps media on a private or direct post private (Mastodon names its files with `SecureRandom.hex(8)` for the same reason). Avatars and headers are public in Mastodon, so their keys keep the upload's id. Attachments stored before migration 0103 sit at `attachments/{accountId}/{mediaId}` until the `RekeyLegacyMedia` job moves them; see [Moving attachments off id-derived keys](../operations/cloudflare-deploy.md#moving-attachments-off-id-derived-keys). The `IMAGES` binding is reserved for transforms; it is not used on the read path yet.

| Var                         | Purpose                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_REKEY_DELETE_LEGACY` | Whether the `RekeyLegacyMedia` job deletes the object left at an attachment's old, id-derived key once the row points at its copy (default off; `true` deletes). While off, the old URL stays reachable on the media hostname |

`GET /media/:id` follows Mastodon's `MediaController#show`: for media attached to a local status that the signed-in browser session may see, it redirects (302) to the file URL. Unattached media, an unknown id, and a status the viewer may not see answer 404.

### CORS / allowed origins

<!-- constrained-by ../operations/cloudflare-deploy.md -->

| Surface                                                                       | Behavior                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker media proxy (`/media/*`, `/attachments/*`, `/avatars/*`, `/headers/*`) | `Access-Control-Allow-Origin: *` (GET/HEAD/OPTIONS; no credentials)                                                                                                                                                 |
| Worker `/api/*`                                                               | Reflect `Origin` only when it matches `INSTANCE_PUBLIC_ORIGIN` or an entry in `CORS_ALLOWED_ORIGINS` (comma-separated). Allows `Authorization`, `Content-Type`. Also applies to `/oauth/token` and `/oauth/revoke`. |
| Production R2 custom domain                                                   | Apply a bucket CORS policy (see [`infra/cloudflare/media-cors.json.example`](../../infra/cloudflare/media-cors.json.example) and deploy checklist). Worker CORS does not cover R2 hostnames.                        |

`CORS_ALLOWED_ORIGINS` is optional. Empty ⇒ API CORS still allows the instance public origin. Trailing slashes are normalized.

## Authentication

<!-- constrained-by ../operations/cloudflare-deploy.md -->

People sign in with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/). Access checks a passkey of its own, or an identity provider such as WorkOS, and sends `Cf-Access-Jwt-Assertion`. This server verifies that JWT and provisions the local account from the address. It does not register passkeys and has no password. `Authorization: Bearer` is a Mastodon OAuth token, never an Access JWT.

Void's [Better Auth](https://www.better-auth.com/) store (`packages/worker/app/auth.ts`, mounted at `/api/auth/*`) keeps the user and session rows that link an Access subject to an account and to the web app's token. It is not a login method: no passwords, no passkey plugin. The admin plugin's `admin` role is still how an account is an instance admin. Mastodon clients never use those rows directly: the Worker is its own OAuth 2 authorization server and turns a signed-in Access session into an access token.

| Surface                                                    | Purpose                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/sign_in`                                        | Who Access signed in, or an explanation that Access is the login; sign-out drops the local session and sends the browser to `/cdn-cgi/access/logout`. `GET /login` redirects here                                               |
| `GET /auth/sign_up`                                        | Redirects to `/auth/sign_in`. A new address gets an account when registrations are open; the username comes from the address                                                                                                    |
| `GET /auth/edit`                                           | Password and security: the Access session and authorized apps. Passkeys stay in Access. Changes need a sign-in within 10 minutes of the JWT `iat` (`signedInAt`). Access may re-issue that token from a still-valid org session |
| `POST /api/v1/apps`, `GET /api/v1/apps/verify_credentials` | Register a client (`client_name`, `redirect_uris`, `scopes`); the secret is shown once                                                                                                                                          |
| `GET`/`POST /oauth/authorize`                              | Consent page (needs the Access session); `code` flow, optional PKCE (`S256`), `urn:ietf:wg:oauth:2.0:oob`                                                                                                                       |
| `POST /oauth/token`                                        | `authorization_code` and `client_credentials` grants; client auth by body or HTTP Basic                                                                                                                                         |
| `POST /oauth/revoke`                                       | RFC 7009 revocation                                                                                                                                                                                                             |
| `GET /.well-known/oauth-authorization-server`              | RFC 8414 metadata                                                                                                                                                                                                               |

API requests authenticate with `Authorization: Bearer <access token>` (streaming also takes `?access_token=`). Client secrets, codes, and tokens are stored as SHA-256 digests (`oauth_applications`, `oauth_authorization_codes`, `oauth_access_tokens`). A token needs the granular scope Mastodon gives the endpoint (`read:statuses` for timelines, `write:favourites` to favourite, `admin:read:reports` for admin reports, …; the table is `SCOPE_RULES` in `packages/worker/src/oauth-scope.ts`). A top-level scope (`read`, `write`, `admin:read`, `admin:write`) covers every granular scope under it, `follow` covers `read`/`write` `:follows` / `:blocks` / `:mutes`, and `profile` allows only `GET /api/v1/accounts/verify_credentials`. Public metadata (instance, custom emojis, trends) needs no scope. Anything else is `403` with `kind: "InsufficientScope"`. Suspended and disabled accounts are refused at every token use.

| Var                      | Purpose                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`     | **Secret**, required off `localhost` / `127.0.0.1` / a name ending in `.local`: signs the Better Auth user and session rows. It is not the login. Void supplies a dev secret only on those hosts                     |
| `CF_ACCESS_TEAM_DOMAIN`  | Access team issuer, `https://<team>.cloudflareaccess.com`. Leading and trailing whitespace and a trailing slash are ignored. Required for browser login                                                              |
| `CF_ACCESS_AUD`          | Access application audience (AUD) tag the JWT must carry                                                                                                                                                             |
| `CF_ACCESS_JWKS_JSON`    | Access public JWKS, as JSON. When empty, `CF_ACCESS_JWKS_URL` is used, and when that is empty the keys are fetched from `<team>/cdn-cgi/access/certs`. Only RSA keys are used                                        |
| `CF_ACCESS_JWKS_URL`     | Optional URL of the Access public JWKS, used when `CF_ACCESS_JWKS_JSON` is empty                                                                                                                                     |
| `CF_ACCESS_ADMIN_GROUPS` | Comma-separated Access group names. When non-empty, every Access login sets admin if the JWT groups intersect this list and clears admin if they do not. When empty or unset, login does not change an existing role |
| `REGISTRATIONS_OPEN`     | Whether a new Access email gets an account (default on; `false` leaves that person signed out). Reported as `registrations.enabled`                                                                                  |
| `REGISTRATION_APPROVAL`  | New accounts wait for admin approval (see [Instance vars](#instance-vars))                                                                                                                                           |
| `ADMIN_USERNAMES`        | Comma-separated usernames granted the Better Auth role `admin` only when that user row is first created. A later login does not grant it again                                                                       |

An account is an instance admin when its Better Auth user's `role` includes `admin`. `ADMIN_USERNAMES` grants that role only when the user row is first created, never again on a later login, so a hand demotion stays demoted. When `CF_ACCESS_ADMIN_GROUPS` is non-empty, it is the ongoing source of truth: every Access login sets admin if the JWT's groups intersect that list and clears admin if they do not. When the list is empty or unset, login does not change an existing role. Promote an existing account in D1 while that list is empty:

```sh
pnpm -C packages/worker exec wrangler d1 execute tstodon --remote --command \
  "UPDATE \"user\" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = 'alice')"
```

Admins suspend accounts on the admin accounts page (`/admin/accounts`). `app/auth.ts` closes every Better Auth endpoint except `/get-session` and `/sign-out`, the admin plugin's `/api/auth/admin/*` included: those routes are not a login and are not how passkeys are registered. Access already verified the email. A new login creates the account when registrations are open; a closed registration, a registration block, or a username this server cannot derive leaves the person signed out, with no account. Approval-required accounts stay pending. One local session exists per Access subject. `DELETE /auth/sign_out` deletes that session; the next request that still carries the Access JWT signs in again. Ending the login is Access logout (`/cdn-cgi/access/logout`).

`signedInAt` is the Access JWT `iat`. Access can re-issue an app token from a still-valid org session, so that time is not always a fresh human sign-in. Moving an account, ending a session, and revoking an app therefore need a short Access session lifetime if a fresh sign-in is required.

An existing account links only when the Access email equals `access_email` exactly. Any other spelling does not attach to that account: open registrations create a second account, and closed registrations leave the person signed out.

```sh
openssl rand -base64 32 | pnpm -C packages/worker exec wrangler secret put BETTER_AUTH_SECRET
```

## Local development authentication

<!-- derived-from #authentication -->

`pnpm dev` serves on `localhost`, where Void supplies a dev `BETTER_AUTH_SECRET`. A browser there is not signed in until Cloudflare Access (or a test that sends `Cf-Access-Jwt-Assertion`) is in front of it: `/auth/sign_in` only explains that Access is the login. Worker tests that need an API token seed a Better Auth user, its account, and an OAuth access token in D1 (`packages/worker/test/auth-fixture.ts`, `authHeaders(email, { admin })`). Tests of the browser login mint a JWT with the published test key in `packages/worker/test/access-jwt-fixture.ts` (the private key stays in that test file) and trust the matching public JWKS from `miniflare.bindings` in the root `vite.config.ts`, next to `BETTER_AUTH_SECRET`. That key's `kid` (`tstodon-local-access`) is accepted only on `localhost`, `127.0.0.1`, `::1`, and a name ending in `.local`. The e2e wrangler configs carry the same public JWKS and sign in the same way.

## Web UI

<!-- constrained-by #authentication -->

The browser UI is Mastodon's own web app (its React frontend, AGPL-3.0 like this project), served by this Worker. `pnpm web:build` (`scripts/build-mastodon-web.mjs`) fetches Mastodon at a pinned release (`MASTODON_WEB_REF`, default `v4.7.3`) into `.cache/mastodon-web/`, runs its Vite build, and copies the output into `packages/worker/assets/` (`packs/`, `emoji/`, `sounds/`, `sw.js`, …; all gitignored), where Void serves it as Workers Assets. `pnpm run deploy` runs it first. A build takes a minute or more, so the script does nothing when the assets already hold its output for that ref: `.cache/mastodon-web/assets.stamp` records a digest of the ref, the script, and the `packs/tstodon-web.json` it wrote, and every file that manifest names must still exist. `pnpm web:build --force` builds again regardless. It needs `git`, network access to GitHub and the npm registry, and Corepack (Mastodon builds with Yarn 4).

`app/middleware/03.web-app.ts` plays the part of Mastodon's Rails layout: on the web app's paths (`/`, `/home`, `/@user…`, `/explore…`, `/notifications…`, … — `WEB_APP_PATHS` in `src/web-app.ts`) it renders the HTML shell and the `initial-state` document from `packs/tstodon-web.json`, the compact manifest the build writes. Without a web build those paths fall through to the static `assets/index.html`. `/web/*` redirects to `/*`, and `/@user` (or `/@user/:id`) requested as ActivityPub redirects to `/users/user` (or the note).

A signed-in Access session gets an access token of the built-in `Web` app (`read write follow push`). The token is derived from the session row's secret, so only its digest is stored (`oauth_access_tokens.web_session_id`), and it is refused once the session expires and deleted with it (`DELETE /auth/sign_out`, which the UI calls). The UI saves its preferences with `PUT /api/web/settings` (`web_settings`) and gets them back in the initial state. Streaming follows Mastodon's protocol: `/api/v1/streaming` and `/api/v1/streaming/…`, the token as `access_token` or the WebSocket subprotocol, and `{ stream, event, payload }` messages on the account's `user` stream (public streams are not served).

## Web Push

`VAPID_PRIVATE_JWK` is a **secret** holding the instance's P-256 VAPID private key as a JWK (`{"kty":"EC","crv":"P-256","x":…,"y":…,"d":…}`); its public point is advertised as `vapid_key` on `/api/v1/apps`, as `configuration.vapid.public_key` on `/api/v2/instance`, and as `server_key` on push subscriptions. `VAPID_SUBJECT` is the optional `mailto:` or `https:` contact push services see in the VAPID token. Without `VAPID_PRIVATE_JWK` the instance reports `vapid_key: null`. Generate a key once and keep it: rotating it invalidates every client's subscription. Each OAuth access token holds one subscription (`/api/v1/push/subscription` reads, replaces, or deletes the token's own), revoking the token removes it, and notifications go to every subscription of the account.

```sh
node -e 'const {generateKeyPairSync}=require("crypto");console.log(JSON.stringify(generateKeyPairSync("ec",{namedCurve:"P-256"}).privateKey.export({format:"jwk"})))' \
  | pnpm exec wrangler secret put VAPID_PRIVATE_JWK
```

The test runner injects its own fixture key through `miniflare.bindings` in the root `vite.config.ts`; it is never used outside tests.

## Limited federation

`FEDERATION_ALLOW_HOSTS` is a comma-separated list of the only hosts allowed to federate. A non-empty list (or a runtime `domain_allows` row, managed at `/api/v1/admin/domain_allows`) turns on limited federation: outbound fetches and delivery, inbound inbox activities, and link unfurling refuse any other host, `GET /api/v1/instance/peers` and `/api/v1/instance/activity` require a user token, and `/api/v2/instance` reports `limited_federation: true`. Listed hosts also keep the private-IP exemption used by local e2e setups (`127.0.0.1`). For a listed loopback host (`localhost`, `127.0.0.1`, `::1`), WebFinger is also queried over plain `http://`, so `@user@127.0.0.1:8794` resolves against a local test server; every other host is looked up over `https://`.

`POLL_UPDATE_DELAY_SECONDS` is how long a vote on a local poll waits before the `Update(Question)` that carries the new counts to remote servers; votes cast in that window share one `Update`. It defaults to Mastodon's 180 seconds. The local e2e instances set it to `5`, which Miniflare honours as a queue `delaySeconds`.
