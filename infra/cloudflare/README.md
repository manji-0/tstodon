# Cloudflare infra for tstodon

<!-- constrained-by ../../docs/reference/configuration.md#cloudflare-bindings -->
<!-- constrained-by ../../docs/operations/cloudflare-deploy.md -->

Terraform / OpenTofu skeleton for the **Worker data plane**: D1, R2, the
outbox Queue and its dead-letter queue (IDs/names for `packages/worker/wrangler.jsonc`). Browser login is
Cloudflare Access (its own passkeys, or an IdP such as WorkOS), configured in
the Cloudflare dashboard and on the Worker as `CF_ACCESS_*` (see
[Authentication](../../docs/reference/configuration.md#authentication)). This
skeleton does not create that Access application. Mastodon API clients still
use OAuth tokens this server issues.

The Worker script, Durable Objects, Workflows, Images, and Analytics Engine stay with `wrangler deploy`.

## Layout

| File                      | Contents                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| `workers.tf`              | D1, R2 bucket, outbox Queue and dead-letter queue (+ optional consumers)          |
| `outputs.tf`              | `wrangler_bindings`                                                               |
| `media-cors.json.example` | Sample R2 CORS policy for the media custom domain (`wrangler r2 bucket cors set`) |

## Prerequisites

API token permissions (account-scoped), as needed:

- D1 Edit
- Workers Scripts Edit (queue consumer attach)
- Cloudflare R2 Edit
- Workers Queues Edit

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

1. Apply to create D1 / R2 / the outbox Queue and its dead-letter queue.
2. Copy `tofu output -json wrangler_bindings` into production `packages/worker/wrangler.jsonc`.
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

## Feature flags

| Variable                                   | Default | Purpose                     |
| ------------------------------------------ | ------- | --------------------------- |
| `create_d1` / `create_r2` / `create_queue` | `true`  | Toggle data-plane resources |
| `attach_queue_consumer`                    | `false` | Attach after Worker exists  |

## Queue settings

`wrangler deploy` writes the same two consumers from `packages/worker/app/queues/*.ts`, so keep these equal to the exports there.

| Variable                                                                             | Default                                         | Queue file export                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `outbox_queue_name` / `outbox_dlq_name`                                              | `tstodon-outbox-process` / `tstodon-outbox-dlq` | file names; `deadLetterQueue` in `tstodon-outbox-process.ts`               |
| `queue_consumer_batch_size`, `_max_retries`, `_max_concurrency`, `_max_wait_time_ms` | `10`, `3`, `1`, `0`                             | `maxBatchSize`, `maxRetries`, `maxConcurrency`, `maxBatchTimeout` (outbox) |
| `dlq_consumer_batch_size`, `_max_retries`, `_max_wait_time_ms`                       | `10`, `5`, `5000`                               | the same in `tstodon-outbox-dlq.ts` (concurrency fixed at `1`)             |

## Out of scope

- Durable Object / Workflow / Analytics Engine provisioning
- Automatically rewriting `wrangler.jsonc`
