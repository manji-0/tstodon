# Cloudflare infra for tstodon

<!-- constrained-by ../../docs/reference/configuration.md#cloudflare-bindings -->
<!-- constrained-by ../../docs/operations/cloudflare-deploy.md -->

Terraform / OpenTofu skeleton for the **Worker data plane**: D1, KV, R2, and the
Queue (IDs/names for `packages/worker/wrangler.jsonc`). Sign-in is the Worker's
own (Better Auth passkeys and Mastodon OAuth), so there is no Access or IdP
configuration here.

The Worker script, Durable Objects, Workflows, Images, and Analytics Engine stay with `wrangler deploy`.

## Layout

| File                      | Contents                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| `workers.tf`              | D1, KV namespaces, R2 bucket, Queue (+ optional consumer)                         |
| `outputs.tf`              | `wrangler_bindings`                                                               |
| `media-cors.json.example` | Sample R2 CORS policy for the media custom domain (`wrangler r2 bucket cors set`) |

## Prerequisites

API token permissions (account-scoped), as needed:

- Workers KV Storage Edit
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

1. Apply to create D1 / KV / R2 / Queue.
2. Copy `tofu output -json wrangler_bindings` into production `packages/worker/wrangler.jsonc`.
3. Skipped: `pnpm run deploy` applies remote D1 migrations.
4. `pnpm run deploy` (`void deploy --backend cloudflare`)
5. Re-apply with `attach_queue_consumer = true` so the Queue consumer points at the Worker.

## Outputs to wire

| Output                                        | Destination                        |
| --------------------------------------------- | ---------------------------------- |
| `wrangler_bindings.d1_database_id`            | `d1_databases[].database_id`       |
| `wrangler_bindings.kv_remote_dns_cache_id`    | `kv_namespaces` `REMOTE_DNS_CACHE` |
| `wrangler_bindings.kv_app_cache_id`           | `kv_namespaces` `APP_CACHE`        |
| `wrangler_bindings.r2_media_bucket_name`      | `r2_buckets[].bucket_name`         |
| `wrangler_bindings.outbox_process_queue_name` | `queues.producers/consumers`       |

## Feature flags

| Variable                                                 | Default | Purpose                     |
| -------------------------------------------------------- | ------- | --------------------------- |
| `create_d1` / `create_kv` / `create_r2` / `create_queue` | `true`  | Toggle data-plane resources |
| `attach_queue_consumer`                                  | `false` | Attach after Worker exists  |

## Out of scope

- Durable Object / Workflow / Analytics Engine provisioning
- Automatically rewriting `wrangler.jsonc`
