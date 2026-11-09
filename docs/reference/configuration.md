# Configuration Reference

## Cloudflare bindings

<!-- constrained-by ../architecture/tstodon-architecture.md#cloudflare-mapping -->

Configured in `packages/worker/wrangler.jsonc`:

- `DB` — D1
- `MEDIA` — R2
- `REMOTE_DNS_CACHE`, `APP_CACHE` — KV
- `OUTBOX_PROCESS_QUEUE` — Queue producer/consumer (`ExpandFollowers` fan-out, `ProcessExpiredPolls` and the other outbox jobs)
- `OUTBOX_DLQ` — producer of `tstodon-outbox-dlq`, the outbox queue's dead-letter queue (see [Outbox dead-letter queue](#outbox-dead-letter-queue))
- `STREAM_HUB` — Durable Object
- `RATE_LIMIT_COUNTER` — Durable Object `RateLimitCounter`, the rate-limit counters (see [Rate limits](#rate-limits))
- `OUTBOX_DELIVERY_WORKFLOW` — per-inbox delivery retries
- `IMAGES` — Images (dimensions, `small` preview and blurhash of image uploads; see [Image processing](#image-processing))
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

Object keys: `attachments/{accountId}/{name}`, `avatars/{accountId}/{blobId}`, `headers/{accountId}/{blobId}`. An attachment's `name` is 128 random bits in hex, stored in the row's `object_key` and never derived from the media id. Both hostnames serve every object without auth, so that name is what keeps media on a private or direct post private (Mastodon names its files with `SecureRandom.hex(8)` for the same reason). Avatars and headers are public in Mastodon, so their keys keep the upload's id. Attachments stored before migration 0103 sit at `attachments/{accountId}/{mediaId}` until the `RekeyLegacyMedia` job moves them; see [Moving attachments off id-derived keys](../operations/cloudflare-deploy.md#moving-attachments-off-id-derived-keys). An image's `small` preview is stored under its own random key in the same prefix (the row's `preview_object_key`).

Attachments are removed as Mastodon removes them. Deleting a status with `delete_media` (and every automated post deletion and moderation removal) deletes its media rows and their objects, original and preview, including media an edit took off the status that its edit history still shows. Without `delete_media` (the web UI's "Delete & redraft") the media stays unattached so the redraft can use it again. The six-hourly cron (`17 */6 * * *`) queues `VacuumMediaAttachments`, the counterpart of Mastodon's daily `Vacuum::MediaAttachmentsVacuum`: it deletes media uploaded over a day ago that no status holds, unless a scheduled post names it or an edit history of one of the owner's statuses shows it, 100 rows a pass, queueing the next pass after a full one. Deleting an account removes all of its objects. Remote media is never stored in the bucket.

| Var                         | Purpose                                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_REKEY_DELETE_LEGACY` | Whether the `RekeyLegacyMedia` job deletes the object left at an attachment's old, id-derived key once the row points at its copy (default off; `true` deletes). While off, the old URL stays reachable on the media hostname |

`GET /media/:id` follows Mastodon's `MediaController#show`: for media attached to a local status that the signed-in browser session may see, it redirects (302) to the file URL. Unattached media, an unknown id, and a status the viewer may not see answer 404.

### Image processing

<!-- derived-from #media-public-urls -->

On a JPEG, PNG, WebP or AVIF upload, the Worker uses the `IMAGES` binding (Workers Images) to read the original's width and height, build a WebP preview within Mastodon's `small` budget of 230,400 pixels (640x360, aspect kept, never enlarged), and sample a 100-pixel PNG thumbnail of the preview, from which it computes a 4x4-component blurhash in the Worker. The preview goes to `MEDIA` beside the original, and the sizes, the preview's key and the blurhash to `media_attachments` (migration 0117). The REST document then lists `meta.original` and `meta.small`, the preview as `preview_url`, and the `blurhash`; the federated `Document` carries the `blurhash`, `width` and `height`. The original is stored without its metadata (see [Media metadata](#media-metadata)), not resized or re-encoded: unlike Mastodon, an original over 8,294,400 pixels (3840x2160) is kept at its size.

Without the binding, or when Images fails (for example, when Images is not enabled on the account, or the file is not a readable image), the upload still succeeds as before: `meta` has no sizes, `preview_url` is the original's URL, and `blurhash` is `null`; the Worker logs `MediaImageNotProcessed`. GIF and video uploads are never processed. Uploads made before this are not processed afterwards. Locally and in tests, Miniflare serves the binding with `sharp`. Each image upload makes two `info` calls and two transformations; see Cloudflare's Images pricing for what the binding bills.

### Media metadata

<!-- derived-from #image-processing -->

Media attachments, avatars and headers are stored without the metadata cameras, phones and editors write, so a photo's or video's GPS position, device, owner, dates and edit history are not published (Mastodon gets the same by re-encoding images with libvips and videos with ffmpeg's `-map_metadata -1`). `UploadMetadata.forUpload` (`packages/domain/src/upload-metadata.ts`, over `ImageMetadata` in `image-metadata.ts` and `VideoMetadata` in `video-metadata.ts`) rewrites the container losslessly in the Worker before the bytes go to `MEDIA`; it needs no `IMAGES` binding, decodes no pixels or frames, and runs in time linear in the file size. The format is judged by the bytes, not the declared type, and the R2 object's size is that of the stripped file.

| Format | Removed                                                                                                                                                | Kept                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JPEG   | APP1 (EXIF with GPS and thumbnail, XMP, extended XMP), APP13 (Photoshop/IPTC), comments, every other APPn (MPF, FlashPix, Ducky, ...), bytes after EOI | JFIF APP0, APP2 `ICC_PROFILE`, APP14 `Adobe` (colour transform), all image segments and scans as they were                                               |
| PNG    | `eXIf`, `tEXt`, `zTXt`, `iTXt`, `tIME`, any private or unknown ancillary chunk (Apple's `iDOT`, C2PA, ...), bytes after IEND                           | critical chunks, `iCCP`, `sRGB`, `gAMA`, `cHRM`, `cICP`, `mDCV`, `cLLI`, `sBIT`, `tRNS`, `bKGD`, `hIST`, `pHYs`, `sPLT`, APNG's `acTL` / `fcTL` / `fdAT` |
| WebP   | `EXIF`, `XMP ` and unknown chunks; the VP8X EXIF/XMP flags and the RIFF size are rewritten                                                             | `VP8X`, `ICCP`, `ANIM`, `ANMF`, `ALPH`, `VP8 `, `VP8L`                                                                                                   |
| AVIF   | the bytes of `Exif` items (left as an empty IFD) and XMP (`mime` `application/rdf+xml`) items are overwritten in place, so no offset changes           | everything else, including the `irot` / `imir` orientation properties                                                                                    |

The ICC profile is kept so colours stay as the author saw them; it says nothing about the person or place.

Orientation: dropping EXIF would drop the Orientation tag, and a phone photo stored sideways would display sideways. The stripper keeps that one tag: a JPEG, PNG or WebP whose EXIF orientation is 2 to 8 gets a new, 26-byte EXIF block whose IFD0 holds only the Orientation (no GPS, Exif or thumbnail IFD), so every viewer that turned the original upright still does; an orientation of 1 is dropped. The pixels are not rotated, so this works without the `IMAGES` binding. When the binding is there, `meta.original` gives the size as displayed (a 4000x3000 JPEG with orientation 6 is `3000x4000`), and the WebP preview is upright.

Videos (`video/mp4`, `video/webm`) are rewritten in place: nothing moves and the file keeps its length. A metadata box becomes a `free` box, a metadata element an EBML `Void` element, of the same size and with a zeroed payload, so the chunk offsets (`stco` / `co64`), fragment offsets, SeekHead and Cues positions that point past it stay valid. The walk reads box and element headers only, never the samples or clusters.

| Container                     | Removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Kept                                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MP4, MOV, M4V, 3GP (ISO BMFF) | `udta` (`©xyz` location, `©mak` / `©mod` / `©day`, GoPro `GPMF`, `XMP_`, track names) and `meta` (Apple's `mdta` keys such as `com.apple.quicktime.location.ISO6709`, iTunes `ilst`) under `moov`, `trak`, `moof` and `traf`; `meco`; any `©`-named atom; `uuid` boxes with the XMP, Canon CMT or Sony user-metadata UUID, and every top-level `uuid`; `prft`; a top-level `meta` (one with handler `pict` keeps its items, but its `Exif` and XMP items are blanked as in AVIF); timed metadata tracks (handler `meta` or `camm`: GoPro GPS, DJI, Google CAMM, Apple `mebx`): the `trak` and their `traf` fragments become `free` and their samples in `mdat` are zeroed; the creation and modification times of `mvhd`, `tkhd` and `mdhd` are set to 0, as ffmpeg writes them | `ftyp`, `mdat`, every video, audio and subtitle track with its sample tables, edit lists, `tref`, sample descriptions (colour, HDR, codec configuration), the `tkhd` rotation matrix, `mvex`, `moof` / `traf` / `trun`, `sidx`, PIFF and `pssh` boxes |
| WebM, Matroska (EBML)         | `Tags` and `Attachments` (cover art, fonts); from `Info`: `Title`, `DateUTC`, `SegmentFilename`, `PrevFilename`, `NextFilename`, `SegmentUUID`, `PrevUUID`, `NextUUID`, `SegmentFamily`; each track's `Name`; the SeekHead entries pointing at Tags or Attachments; the `CRC-32` of every element changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the EBML header, `SeekHead`, `Info`'s `TimestampScale`, `Duration`, `MuxingApp` and `WritingApp` (mandatory, they name software), `Tracks`, `Cluster`, `Cues`, `Chapters`                                                                             |

Unlike Mastodon, the video is not transcoded: every video, audio and subtitle track stays (Mastodon keeps one video and one audio stream), so a telemetry subtitle track (DJI's `.srt` muxed in) is not removed, nor are chapter titles, the encoder name inside a sample description or a codec's own bitstream (x264's settings SEI), or a WebM's `MuxingApp` / `WritingApp`. Unknown boxes outside `moov` / `moof` and unknown `uuid` boxes below the top level are kept, as some players need them.

A file that cannot be rewritten is refused rather than stored with its metadata: `POST /api/v1/media` and `/api/v2/media` answer 422 (`file is not a readable image/png file`, `ValidationError`), and `update_credentials` answers 422 for that avatar or header. That is a file whose JPEG, PNG, WebP, AVIF, MP4 or WebM container does not hold together before its image data (a truncated header, a chunk, box or element past the end of the file or of its parent, a PNG without IEND, an MP4 without `moov`, a WebM without `Tracks` or whose DocType is neither `webm` nor `matroska`, a metadata element of unknown size, a timed metadata sample outside `mdat`), or one whose bytes are not of its declared kind: a JPEG, PNG, WebP or AVIF upload must be one of those images, an MP4 or WebM upload must be an MP4 or WebM file (either; an iPhone's QuickTime MOV sent as `video/mp4` is fine). The Worker logs `MediaImageRejected` / `MediaVideoRejected` / `ProfileImageRejected`. A JPEG that ends inside its compressed data, an MP4 whose last box is an `mdat` cut short, and a WebM cut inside a Cluster are kept, as browsers play them as far as they go. GIF passes through unchanged (its comment and XMP extensions are not removed), as do custom emoji images.

Objects stored before stripping existed are rewritten in place by the `StripStoredMediaMetadata` queue job, which the six-hourly cron starts: attachment originals, avatars and headers, 10 rows and at most 64 MiB per message, objects over 32 MiB passed over, a container that cannot be walked left as it is with the reason recorded. Uploads are marked as stripped when stored (migration 0119: `media_attachments.metadata_stripped_at`, `account_profiles.avatar_metadata_stripped_at` / `header_metadata_stripped_at`), so the job never reads them. The URL stays the same, so caches serve the old bytes until they expire or are purged; see [Stripping metadata from stored media](../operations/cloudflare-deploy.md#stripping-metadata-from-stored-media).

### Media storage accounting

<!-- constrained-by ../operations/cloudflare-deploy.md#recording-stored-media-sizes -->

tstodon records the byte size of every object it stores in `MEDIA` (migration 0125): attachment originals and their IMAGES previews (`media_attachments.file_size` / `preview_file_size`), avatars and headers (`account_profiles.avatar_file_size` / `header_file_size`) and custom emoji images (`custom_emojis.image_file_size`). The size is what R2 reports for the stored bytes, after metadata stripping, and the `StripStoredMediaMetadata` rewrite records the new size. Nothing needs configuring.

| Where                                                       | What it shows                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/admin/dimensions`, `space_usage`              | `d1` (the database size D1 reports) and `media` ("Media storage"): originals, previews, a legacy copy the rekey job keeps (counted at the original's size), avatars, headers and custom emoji images                     |
| `POST /api/v1/admin/measures`, `instance_media_attachments` | for this server's own `domain`: the attachments' originals and previews, in total and by upload day; 0 for any other domain, since tstodon links remote media rather than caching it (Mastodon counts its cached copies) |
| `/settings/export`                                          | "Media storage" of the signed-in account: its attachments, avatar and header                                                                                                                                             |

Sizes are shown in binary units with three significant digits, as Mastodon's `number_to_human_size` (`1.18 MB`). Nothing else tstodon creates is stored in the bucket: link card images, remote avatars and remote media are not cached, and the images of the `CUSTOM_EMOJIS` var are hosted elsewhere. Objects stored before sizes were recorded count 0 until the `BackfillStoredMediaSizes` job has read them; see [Recording stored media sizes](../operations/cloudflare-deploy.md#recording-stored-media-sizes).

### CORS / allowed origins

<!-- constrained-by ../operations/cloudflare-deploy.md -->

| Surface                                                                       | Behavior                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker media proxy (`/media/*`, `/attachments/*`, `/avatars/*`, `/headers/*`) | `Access-Control-Allow-Origin: *` (GET/HEAD/OPTIONS; no credentials)                                                                                                                                                 |
| Worker `/api/*`                                                               | Reflect `Origin` only when it matches `INSTANCE_PUBLIC_ORIGIN` or an entry in `CORS_ALLOWED_ORIGINS` (comma-separated). Allows `Authorization`, `Content-Type`. Also applies to `/oauth/token` and `/oauth/revoke`. |
| Production R2 custom domain                                                   | Apply a bucket CORS policy (see [`infra/cloudflare/media-cors.json.example`](../../infra/cloudflare/media-cors.json.example) and deploy checklist). Worker CORS does not cover R2 hostnames.                        |

`CORS_ALLOWED_ORIGINS` is optional. Empty ⇒ API CORS still allows the instance public origin. Trailing slashes are normalized.

## Outbox dead-letter queue

<!-- constrained-by ../operations/runbook.md#dead-lettered-jobs -->

`tstodon-outbox-process` dead-letters to `tstodon-outbox-dlq` (`deadLetterQueue` in `packages/worker/app/queues/tstodon-outbox-process.ts`; `queueConsumerOptions` in `void-plugins.ts` writes it as the consumer's `dead_letter_queue`, since Void's queue file has no such option). The outbox handler decides about a job that returns retry: it retries it twice, then sends `{"kind": "DeadOutboxJob", "job": <body as queued>, "attempts": 3}` to `OUTBOX_DLQ` and acks it. Queues itself moves what the handler cannot decide: a message it throws on, or one that is not an `OutboxJob`, after `max_retries` (3, so 4 deliveries). If the send to `OUTBOX_DLQ` fails, the message is retried instead, so Queues dead-letters it in the end.

The dead-letter queue's consumer (`app/queues/tstodon-outbox-dlq.ts`: batches of 10, `max_retries` 5, `max_concurrency` 1) stores each message in the D1 table `outbox_dead_jobs` (migration 0127): `job_kind`, `reason` (`RetriesExhausted`, `HandlerFailed` or `Unparseable`), `body_json`, `attempts`, `dead_count`, `error`, `first_seen_at` and `last_seen_at`. The `RequeueDeadOutboxJobs` job sends stored jobs back. Both queues are provisioned by [`infra/cloudflare`](../../infra/cloudflare/README.md) (`outbox_queue_name`, `outbox_dlq_name`). In `vp dev`, Void writes the consumers without `dead_letter_queue` (the option is added to the build output only), so only the handler's own sends reach the local dead-letter queue.

## Activity retention

<!-- constrained-by ../operations/runbook.md#retention -->

The six-hourly cron queues `VacuumActivities`, which prunes three tables (rules in the runbook's [Retention](../operations/runbook.md#retention)). Each var is a number of days; empty or unset is the default, `0` or `off` stops pruning that table, anything else is the default.

| Var                                | Default | Prunes                                                                                                                         |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OUTBOX_DELIVERY_RETENTION_DAYS`   | `30`    | `outbox_deliveries` rows in a final state (`Delivered`, `Failed`, `Expanded`), by `updated_at`                                 |
| `OUTBOUND_ACTIVITY_RETENTION_DAYS` | `30`    | `outbound_activities` by `created_at`, except those still being delivered and each account's newest 40 public posts and boosts |
| `INBOX_ACTIVITY_RETENTION_DAYS`    | `30`    | `inbox_activities` (the inbox's dedupe by activity id) by `created_at`; at least `7` days                                      |

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

API requests authenticate with `Authorization: Bearer <access token>` (streaming also takes `?access_token=`). Client secrets, codes, and tokens are stored as SHA-256 digests (`oauth_applications`, `oauth_authorization_codes`, `oauth_access_tokens`). A token needs the granular scope Mastodon gives the endpoint (`read:statuses` for timelines, `write:favourites` to favourite, `admin:read:reports` for admin reports, …; the table is `SCOPE_RULES` in `packages/worker/server/oauth-scope.ts`). A top-level scope (`read`, `write`, `admin:read`, `admin:write`) covers every granular scope under it, `follow` covers `read`/`write` `:follows` / `:blocks` / `:mutes`, and `profile` allows only `GET /api/v1/accounts/verify_credentials`. Public metadata (instance, custom emojis, trends) needs no scope. Anything else is `403` with `kind: "InsufficientScope"`. Suspended and disabled accounts are refused at every token use.

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

`pnpm dev` serves on `localhost`, where Void supplies a dev `BETTER_AUTH_SECRET`. A browser there is not signed in until Cloudflare Access (or a test that sends `Cf-Access-Jwt-Assertion`) is in front of it: `/auth/sign_in` only explains that Access is the login. Worker tests that need an API token seed a Better Auth user, its account, and an OAuth access token in D1 (`packages/worker/test/auth-fixture.ts`, `authHeaders(email, { admin })`). Tests of the browser login mint a JWT with the published test key in `packages/worker/test/access-jwt-fixture.ts` (the private key stays in that test file) and trust the matching public JWKS from `miniflare.bindings` in the root `vite.config.ts`, next to `BETTER_AUTH_SECRET`. That key's `kid` (`tstodon-local-access`) is accepted only on `localhost`, `127.0.0.1`, `::1`, a name ending in `.local`, and a name ending in `.localhost` (the portless e2e pair). The e2e wrangler configs carry the same public JWKS and sign in the same way.

## Web UI

<!-- constrained-by #authentication -->

The browser UI is Mastodon's own web app (its React frontend, AGPL-3.0 like this project), served by this Worker. Its source is vendored in `packages/worker/src`, the client of the Void app in `packages/worker` (Void's "SPA + API" shape): Mastodon's `app/javascript` at the release `packages/worker/src/upstream.json` names (`v4.7.5`), upstream's Vite plugins in `packages/worker/config/`, and its Vite config ported to `packages/worker/web-build.ts`, with tstodon's changes listed in `packages/worker/src/UPSTREAM.md` (among them the tstodon branding, which still credits Mastodon). Change the UI there; its dependencies are in `packages/worker/package.json`.

`pnpm build` (`vp -C packages/worker build`) builds the client, then the Worker (`builder.buildApp` in `packages/worker/vite.config.ts`). The client build writes Mastodon's packs under `packages/worker/dist/client/packs/`, the service worker as `dist/client/sw.js`, and copies `packages/worker/public/` (`sounds/`, `badge.png`, the Web Push icons, `index.html`) beside them; that directory is the Worker's static assets. Before it, the build fetches the large static trees upstream keeps in `public/` and tstodon does not commit (`public/emoji`, `public/ocr`) from that upstream commit into `.cache/mastodon-web/upstream/<commit>/` (once per commit; the first build needs `git` and network access to GitHub) and links `public/emoji` into `packages/worker/public/` (gitignored). `public/ocr` (the alt text OCR language data) is not served, as before vendoring. `pnpm dev` serves the frontend from source with Vite's hot reload; `pnpm run deploy` (`void deploy`) runs the same build.

`app/middleware/04.web-app.ts` plays the part of Mastodon's Rails layout: on the web app's paths (`/`, `/home`, `/@user…`, `/explore…`, `/notifications…`, … — `WEB_APP_PATHS` in `server/web-app.ts`) it renders the HTML shell and the `initial-state` document. The `<script>` and `<link>` tags come from `virtual:tstodon/web-manifest` (`server/web-manifest.ts`): in a build, the Worker build reads the client's Vite manifest (`dist/client/.vite/manifest.json`, written first; `public/.assetsignore` keeps `.vite/` out of the uploaded and served assets, so the build reads it but `GET /.vite/manifest.json` is a 404) and embeds the entry files, their CSS and the chunks to preload, with `ref` set to the upstream tag with `+tstodon` (`v4.7.5+tstodon`); on the dev server it names the source entry points, Vite's HMR client and the React Refresh preamble. `/favicon.ico` redirects to the build's favicon. `/web/*` redirects to `/*`, and `/@user` (or `/@user/:id`) requested as ActivityPub redirects to `/users/user` (or the note). A browser navigation to a path nothing answers gets `public/index.html` (Void's SPA fallback after a 404); it never shadows the Worker's routes or the web app's paths.

A signed-in Access session gets an access token of the built-in `Web` app (`read write follow push`). The token is derived from the session row's secret, so only its digest is stored (`oauth_access_tokens.web_session_id`), and it is refused once the session expires and deleted with it (`DELETE /auth/sign_out`, which the UI calls). The UI saves its preferences with `PUT /api/web/settings` (`web_settings`) and gets them back in the initial state. Streaming follows Mastodon's protocol: `/api/v1/streaming` and `/api/v1/streaming/…`, the token as `access_token` or the WebSocket subprotocol, and `{ stream, event, payload }` messages on the account's `user` stream (public streams are not served).

### Appearance

<!-- constrained-by #web-ui -->

The pages the Worker renders itself (sign-in, OAuth consent, `/settings/*`, filters, account security, automated post deletion, `/admin/*`, …) share one frame, `page()` in `server/auth-pages.ts`, and one stylesheet, `src/styles/entrypoints/pages.scss`: the web app's own theme tokens (palette, dark and light mappings, contrast overrides, radii, Inter), built as a hashed pack (`pages` in `virtual:tstodon/web-manifest`). These pages load no script, so the stylesheet resolves `auto` itself with `prefers-color-scheme` and `prefers-contrast`.

Each account picks a colour scheme (`auto`, `light`, `dark`) and a contrast (`auto`, `high`), Mastodon's `color_scheme` and `contrast` user settings, on `/settings/preferences` (Appearance) or `/settings/preferences/appearance`. They are stored in `account_appearance` (migration `0119`; no row means `auto` / `auto`). The HTML shell renders them as `data-color-scheme` / `data-contrast` (with `data-system-theme` only on `auto`, and a single `theme-color` for a chosen scheme), and `app/middleware/06.page-appearance.ts` sets the same attributes on the Worker's own pages for the account `browserSession` resolved for that request (an `HTMLRewriter` pass, one D1 read; signed-out pages are untouched). Signed-out visitors stay on `auto`. Mastodon 4.7's web app has no in-app control for these; it links to the settings page.

## Web Push

`VAPID_PRIVATE_JWK` is a **secret** holding the instance's P-256 VAPID private key as a JWK (`{"kty":"EC","crv":"P-256","x":…,"y":…,"d":…}`); its public point is advertised as `vapid_key` on `/api/v1/apps`, as `configuration.vapid.public_key` on `/api/v2/instance`, and as `server_key` on push subscriptions. `VAPID_SUBJECT` is the optional `mailto:` or `https:` contact push services see in the VAPID token. Without `VAPID_PRIVATE_JWK` the instance reports `vapid_key: null`. Generate a key once and keep it: rotating it invalidates every client's subscription. Each OAuth access token holds one subscription (`/api/v1/push/subscription` reads, replaces, or deletes the token's own), revoking the token removes it, and notifications go to every subscription of the account.

```sh
node -e 'const {generateKeyPairSync}=require("crypto");console.log(JSON.stringify(generateKeyPairSync("ec",{namedCurve:"P-256"}).privateKey.export({format:"jwk"})))' \
  | pnpm exec wrangler secret put VAPID_PRIVATE_JWK
```

The test runner injects its own fixture key through `miniflare.bindings` in the root `vite.config.ts`; it is never used outside tests.

## Limited federation

`FEDERATION_ALLOW_HOSTS` is a comma-separated list of the only hosts allowed to federate. A non-empty list (or a runtime `domain_allows` row, managed at `/api/v1/admin/domain_allows`) turns on limited federation: outbound fetches and delivery, inbound inbox activities, and link unfurling refuse any other host, `GET /api/v1/instance/peers` and `/api/v1/instance/activity` require a user token, and `/api/v2/instance` reports `limited_federation: true`. Listed hosts also keep the private-IP exemption used by local e2e setups (`127.0.0.1`). For a listed loopback host (`localhost`, `127.0.0.1`, `::1`), WebFinger is also queried over plain `http://`, so `@user@127.0.0.1:8794` resolves against a local test server; every other host is looked up over `https://`. A `*.localhost` name is refused until the list names it; the portless pair that uses those names is [Federation e2e over portless](../getting-started/e2e-federation-portless.md).

`POLL_UPDATE_DELAY_SECONDS` is how long a vote on a local poll waits before the `Update(Question)` that carries the new counts to remote servers; votes cast in that window share one `Update`. It defaults to Mastodon's 180 seconds. The local e2e instances set it to `5`, which Miniflare honours as a queue `delaySeconds`.

## IP blocks

IP blocks are managed at runtime (`/api/v1/admin/ip_blocks`, stored in `ip_blocks`); there is nothing to configure. What operators need to know:

- **Client address.** The Worker reads the client address only from `CF-Connecting-IP`, which Cloudflare sets on every request it forwards and overwrites when a client sends its own. `X-Forwarded-For` and `X-Real-IP` are not read: on Workers they carry whatever the client sent. A request without `CF-Connecting-IP` (a local `wrangler dev` or test call that sets none) has no known address, and no block applies to it. Behind another proxy in front of Cloudflare (a CDN that connects to Cloudflare for its clients), `CF-Connecting-IP` is that proxy's address unless the proxy is set up as Cloudflare documents for passing the visitor address (for example Pseudo IPv4 or a Cloudflare-for-SaaS origin), so a block on a client range would not match; block the proxy's range only if that is the intent.
- **`no_access`** refuses every request from the range with `403 Forbidden`, before routing (`app/middleware/00.ip-block.ts`). Federation requests (inbox deliveries, actor and object fetches, WebFinger, NodeInfo) are refused too, as Mastodon's Rack::Attack blocklist applies to every path: a server whose outgoing address is in the range cannot deliver to or fetch from this one. To stop a whole server federating, a domain block is the tool; `no_access` is for addresses.
- **`sign_up_block`** refuses a new account from the range at the Access sign-in (`/auth/sign_in`), and **`sign_up_requires_approval`** creates it waiting for an admin, as `REGISTRATION_APPROVAL` does for everyone. Existing accounts are not affected.
- **Caching.** Each isolate reads the block list once a minute. A change made through the admin API takes effect at once in the isolate that made it and within a minute everywhere else. An expired block (`expires_in`) stops applying at its expiry. If D1 cannot be read, no block applies until the next read (fail open).

The addresses a local account signs up and makes authenticated requests from are recorded in `account_ips` (as Mastodon's `user_ips`) for `Admin::Account#ip`/`#ips` and the admin `ip` filter, and the days it was active in `account_activity_days` for the dashboard's `active_users` and retention; both are written at most once per account, address and day per isolate.

## Rate limits

<!-- derived-from #ip-blocks -->

The Worker throttles requests as Mastodon's Rack::Attack and its per-account `RateLimiter` do. The policy (which buckets a request counts against, the defaults, the fixed windows) is `RateLimit` in `packages/domain/src/rate-limit.ts`; `app/middleware/02.rate-limit.ts` (`server/rate-limit.ts`) enforces it after CORS, so a 429 still carries the CORS headers a browser client needs, and before the discovery documents and the routes.

**Buckets and defaults.** Every window is fixed and aligned to the epoch, as Rack::Attack's are (a 5-minute window ends on a multiple of 300 seconds).

| Bucket             | Counted per    | Requests                                                                              | Default (Mastodon)                                        |
| ------------------ | -------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `api_ip`           | client address | `/api/*` without a token that authenticates                                           | 300 / 5 min (`throttle_unauthenticated_api`)              |
| `api_token`        | OAuth token    | `/api/*` with a valid token (an app token counts here only)                           | 300 / 5 min (`throttle_per_token_api`)                    |
| `api_account`      | account        | `/api/*` with any of the account's tokens                                             | 1500 / 5 min (`throttle_authenticated_api`)               |
| `media`            | account        | `POST /api/v1/media`, `POST /api/v2/media`                                            | 30 / 30 min (`throttle_api_media`, `RateLimiter` `media`) |
| `statuses`         | account        | `POST /api/v1/statuses` (scheduled ones too)                                          | 300 / 3 h (`RateLimiter` `statuses`)                      |
| `reblogs`          | account        | `POST /api/v1/statuses/:id/reblog`                                                    | 300 / 3 h (`RateLimiter` `reblogs`)                       |
| `follows`          | account        | `POST /api/v1/accounts/:id/follow`                                                    | 400 / 24 h (`RateLimiter` `follows`)                      |
| `reports`          | account        | `POST /api/v1/reports`                                                                | 400 / 24 h (`RateLimiter` `reports`)                      |
| `sign_in`          | client address | `GET /auth/sign_in` (where Access provisions a new account), `POST /oauth/authorize`  | 25 / 5 min (`throttle_login_attempts/ip`)                 |
| `app_registration` | client address | `POST /api/v1/apps`                                                                   | 5 / 10 min (app registrations per address)                |
| `oauth_token`      | client address | `POST /oauth/token`                                                                   | 25 / 5 min (no Mastodon throttle; as login attempts)      |
| `federation_fetch` | client address | `GET`/`HEAD` of `/.well-known/*`, `/nodeinfo/*`, `/users/*`, `/actor`                 | 1500 / 5 min (Mastodon has none)                          |
| `inbox_ip`         | client address | `POST /inbox`, `/actor/inbox`, `/users/:username/inbox`, before anything else is read | 1500 / 5 min (Mastodon has none)                          |
| `inbox_domain`     | sending server | the same deliveries, once their HTTP signature verified                               | 3000 / 5 min (Mastodon has none)                          |

An authenticated API request counts against its token and its account, not its address, as in Mastodon; a token that does not authenticate counts as its address. Staff are not exempt (Mastodon does not exempt them either). The action families count attempts, where Mastodon's `RateLimiter` counts the statuses, boosts, follows and reports actually created. The streaming socket (`/api/v1/streaming`), Better Auth's `/api/auth/*`, the web app's pages and media are not counted. `inbox_domain` keys on the host serving the actor whose key verified, after the signature check, so a forged or unsigned delivery naming another server cannot spend that server's budget; `inbox_ip` in front of it bounds what a flood of forged deliveries costs (each needs a body read and an RSA verification, and an unknown key one fetch).

**Responses.** A request over a limit gets `429` with Mastodon's body, `{"error":"Too many requests"}`, `Retry-After` (seconds to the end of the window) and `X-RateLimit-Limit`, `X-RateLimit-Remaining` (`0`) and `X-RateLimit-Reset` (an ISO 8601 time). Every `/api/*` response that was counted carries the same three headers for the counter with the least left, as Mastodon's API does. Remote servers retry a 429 inbox delivery later.

**Client address.** As for [IP blocks](#ip-blocks), only `CF-Connecting-IP`; without it (local `wrangler dev`, tests) no address-keyed bucket applies. IPv6 addresses count per `/64` (Mastodon's `throttleable_remote_ip`), since one host routinely holds a whole `/64`.

**Configuration.**

- `RATE_LIMITS_ENABLED`: `false` (or `0`, `off`, `no`) turns every limit off. Unset means on. The test Worker sets it to `false` in the root `vite.config.ts`; `server/rate-limit.test.ts` turns the limits on for the apps it builds.
- `RATE_LIMITS`: a JSON object of overrides by bucket name, each `{ "limit": n, "period": seconds }` or `false` to lift that bucket. For example `{"api_ip": {"limit": 600, "period": 300}, "inbox_domain": false}`. Buckets not named keep the defaults. A value that is not JSON, names an unknown bucket or has a malformed rule is ignored as a whole (the defaults apply and the Worker logs a warning).

Both are optional plain vars (`wrangler.jsonc` `vars`, or the dashboard); neither is a secret.

**Storage.** Each subject (an address, an account, an app token, a sending server) is one instance of the `RateLimitCounter` Durable Object (`RATE_LIMIT_COUNTER`, migration tag `v2`), holding that subject's counters in memory and in its SQLite storage; a request costs one Durable Object call per subject it counts against (one for most requests), and no D1 write. An alarm at the end of the last window deletes the instance's storage. Each isolate also remembers a counter it saw over its limit until that window ends and refuses without asking the Durable Object, so a flood from one client costs one call per window per isolate. If the Durable Object cannot be reached the request goes through (fail open), as with IP blocks. A Worker configured without the binding (the local e2e instances) counts nothing.

The Workers Rate Limiting binding (`ratelimits` in `wrangler.jsonc`) was not used: it offers only 10- and 60-second periods, fixes each limit in `wrangler.jsonc` at deploy time, counts per Cloudflare location, and reports no remaining count for `X-RateLimit-Remaining`. Workers KV is eventually consistent and takes one write per key per second; D1 would be a write per request. For volumetric floods, put a Cloudflare WAF rate-limiting rule in front of the Worker as an outer layer (see [Cloudflare Deploy Checklist](../operations/cloudflare-deploy.md#rate-limiting-at-the-edge)); it drops traffic before it reaches the Worker at all.
