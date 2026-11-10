# Cloudflare infra for tstodon

<!-- constrained-by ../../docs/reference/configuration.md#cloudflare-bindings -->
<!-- constrained-by ../../docs/operations/cloudflare-deploy.md -->

Terraform / OpenTofu for the Cloudflare side of tstodon: D1, R2, the
outbox Queue and its dead-letter queue (IDs/names for `packages/worker/wrangler.jsonc`),
the media bucket's public hostname and CORS policy, and the Cloudflare Access
applications in front of the browser paths. Browser login is Cloudflare Access
(its own passkeys, or an IdP such as WorkOS); the Worker reads its JWT through
`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (see
[Authentication](../../docs/reference/configuration.md#authentication)). Mastodon
API clients still use OAuth tokens this server issues.

The Worker script, Durable Objects, Workflows, Images, and Analytics Engine stay with `wrangler deploy`.
CI runs `tofu fmt -check` and `tofu validate` on this directory (job `infra`).

## Layout

| File                      | Contents                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- |
| `workers.tf`              | D1, R2 bucket, outbox Queue and dead-letter queue (+ optional consumers)     |
| `media.tf`                | R2 custom domain for the media bucket and its CORS policy (`media_hostname`) |
| `access.tf`               | Access applications and policies: sign-in, and the federation/API bypass     |
| `outputs.tf`              | `wrangler_bindings`, `access_aud`, `media_public_base_url`                   |
| `media-cors.json.example` | The same CORS policy for `wrangler r2 bucket cors set`, without OpenTofu     |

## Prerequisites

API token permissions (account-scoped), as needed:

- D1 Edit
- Workers Scripts Edit (queue consumer attach)
- Cloudflare R2 Edit (bucket, custom domain, CORS)
- Workers Queues Edit
- Access: Apps and Policies Edit (`create_access`)
- Zone Read on the media hostname's zone (`media_hostname`) **(verify)**

`create_access` needs a Zero Trust organization (its team domain is `CF_ACCESS_TEAM_DOMAIN`) and its identity providers (Access one-time PIN, passkeys, or an IdP such as WorkOS), set up in the dashboard; `access_allowed_idps` picks among them by id.

## Usage

```sh
cd infra/cloudflare
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — never commit it
export CLOUDFLARE_API_TOKEN=...

tofu init
tofu plan
tofu apply
```

### Suggested apply order

1. Apply to create D1 / R2 / the outbox Queue and its dead-letter queue, the media hostname and its CORS policy, and the Access applications.
2. Copy `tofu output -json wrangler_bindings` into production `packages/worker/wrangler.jsonc`, `tofu output access_aud` into `CF_ACCESS_AUD` and `tofu output media_public_base_url` into `MEDIA_PUBLIC_BASE_URL`.
3. Skipped: `pnpm run deploy` applies remote D1 migrations.
4. `pnpm run deploy` (`void deploy --backend cloudflare`)
5. Re-apply with `attach_queue_consumer = true` so both Queue consumers point at the Worker (the outbox consumer with `dead_letter_queue` set to the dead-letter queue).

A state created before the KV namespaces were dropped (OPS-7) still holds `cloudflare_workers_kv_namespace.remote_dns_cache` and `.app_cache`: the next `tofu plan` destroys both. Nothing read `REMOTE_DNS_CACHE`, and `APP_CACHE` only held mail captured in test setups, so deploy the Worker without the `kv_namespaces` bindings first, then apply. To keep the namespaces instead, `tofu state rm` them.

## Outputs to wire

| Output                                        | Destination                               |
| --------------------------------------------- | ----------------------------------------- |
| `wrangler_bindings.d1_database_id`            | `d1_databases[].database_id`              |
| `wrangler_bindings.r2_media_bucket_name`      | `r2_buckets[].bucket_name`                |
| `wrangler_bindings.outbox_process_queue_name` | `queues.producers` `OUTBOX_PROCESS_QUEUE` |
| `wrangler_bindings.outbox_dlq_name`           | `queues.producers` `OUTBOX_DLQ`           |
| `access_aud`                                  | Worker var `CF_ACCESS_AUD`                |
| `media_public_base_url`                       | Worker var `MEDIA_PUBLIC_BASE_URL`        |

## Feature flags

| Variable                                   | Default | Purpose                     |
| ------------------------------------------ | ------- | --------------------------- |
| `create_d1` / `create_r2` / `create_queue` | `true`  | Toggle data-plane resources |
| `attach_queue_consumer`                    | `false` | Attach after Worker exists  |
| `media_hostname`                           | `""`    | R2 custom domain + CORS     |
| `create_access`                            | `false` | Access applications         |

## Queue settings

`wrangler deploy` writes the same two consumers from `packages/worker/app/queues/*.ts`, so keep these equal to the exports there.

| Variable                                                                             | Default                                         | Queue file export                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `outbox_queue_name` / `outbox_dlq_name`                                              | `tstodon-outbox-process` / `tstodon-outbox-dlq` | file names; `deadLetterQueue` in `tstodon-outbox-process.ts`               |
| `queue_consumer_batch_size`, `_max_retries`, `_max_concurrency`, `_max_wait_time_ms` | `10`, `3`, `1`, `0`                             | `maxBatchSize`, `maxRetries`, `maxConcurrency`, `maxBatchTimeout` (outbox) |
| `dlq_consumer_batch_size`, `_max_retries`, `_max_wait_time_ms`                       | `10`, `5`, `5000`                               | the same in `tstodon-outbox-dlq.ts` (concurrency fixed at `1`)             |

## Media hostname

With `media_hostname` (and `zone_id`, the zone it is in), the media bucket answers on that hostname and gets a CORS policy allowing `GET`/`HEAD` from `media_cors_allowed_origins` (default `https://<instance_hostname>`), with `Range` and the conditional headers, and exposing `ETag`, `Content-Length`, `Content-Type`, `Content-Range` and `Accept-Ranges`. Set `MEDIA_PUBLIC_BASE_URL` to `https://<media_hostname>`. Purge the hostname's cache after changing CORS if it was already live. Leave `media_hostname` empty to serve media from the Worker origin (the Access bypass below covers its media paths).

## Access

`create_access = true` creates two self-hosted applications on `instance_hostname`:

- **Sign-in** (`access_application_name`): the whole hostname, so the web UI, `/auth/*`, `/oauth/authorize`, `/settings` and `/admin` need an Access session. Its policy lets in `access_allowed_emails`, `access_allowed_email_domains`, or everyone with `access_allow_everyone` (open registrations; `REGISTRATIONS_OPEN` and `REGISTRATION_APPROVAL` still decide what the account gets). Its `aud` is the output `access_aud`.
- **Federation and API**: a bypass on `/api/*`, `/oauth/token`, `/oauth/revoke`, `/.well-known/*`, `/users/*`, `/inbox`, `/actor` and `/actor/*`, `/nodeinfo` and `/nodeinfo/*`, and the media paths `/media/*`, `/attachments/*`, `/avatars/*`, `/headers/*`. Access prefers the more specific application, so these paths reach the Worker without a cookie.

Check both with the curl loops in the [launch checklist](../../docs/operations/launch-checklist.md#cloudflare-access-paths). An Access application created in the dashboard before is not adopted: delete it, or `tofu import` it, before applying, or the two will overlap.

## Out of scope

- Durable Object / Workflow / Analytics Engine provisioning
- Automatically rewriting `wrangler.jsonc`
- The Zero Trust organization and its identity providers
- The edge rate-limiting rule (dashboard, [deploy checklist](../../docs/operations/cloudflare-deploy.md#rate-limiting-at-the-edge))
- The D1 backup bucket: it belongs in another account ([runbook](../../docs/operations/runbook.md#scheduled-d1-backups))
