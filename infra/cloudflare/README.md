# Cloudflare infra for tstodon

<!-- constrained-by ../../docs/reference/configuration.md#cloudflare-bindings -->
<!-- constrained-by ../../docs/reference/configuration.md#cloudflare-access-authentication-vars -->
<!-- constrained-by ../../docs/operations/cloudflare-deploy.md -->

Terraform / OpenTofu skeleton for:

1. **Worker data plane** — D1, KV, R2, Queue (IDs/names for `wrangler.jsonc`)
2. **Cloudflare Access** — WorkOS OIDC IdP, `/api*` Allow, federation/health Bypass

The Worker script, Durable Objects, Workflows, Images, and Analytics Engine stay with `wrangler deploy`.

## Layout

| File | Contents |
| --- | --- |
| `workers.tf` | D1, KV namespaces, R2 bucket, Queue (+ optional consumer) |
| `access.tf` | Access IdP, policies, applications |
| `outputs.tf` | `wrangler_bindings` and `worker_vars` |

## Prerequisites

API token permissions (account-scoped), as needed:

- Workers KV Storage Edit
- D1 Edit
- Workers Scripts Edit (queue consumer attach)
- Cloudflare R2 Edit
- Workers Queues Edit
- Access: Apps and Policies Edit
- Access: Organizations, Identity Providers, and Groups Edit

WorkOS OIDC redirect URI when Access is enabled:

```text
https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback
```

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

1. Apply with `enable_access = false` (or Access enabled if ready) to create D1 / KV / R2 / Queue.
2. Copy `tofu output -json wrangler_bindings` into production `wrangler.jsonc`.
3. `wrangler d1 migrations apply tstodon --remote`
4. `wrangler deploy`
5. Re-apply with `attach_queue_consumer = true` so the Queue consumer points at the Worker.
6. Apply Access (`enable_access = true`) and copy `tofu output -json worker_vars` into Worker vars. Clear local fixture JWKS/private JWK.

## Outputs to wire

| Output | Destination |
| --- | --- |
| `wrangler_bindings.d1_database_id` | `d1_databases[].database_id` |
| `wrangler_bindings.kv_remote_dns_cache_id` | `kv_namespaces` `REMOTE_DNS_CACHE` |
| `wrangler_bindings.kv_app_cache_id` | `kv_namespaces` `APP_CACHE` |
| `wrangler_bindings.r2_media_bucket_name` | `r2_buckets[].bucket_name` |
| `wrangler_bindings.outbox_process_queue_name` | `queues.producers/consumers` |
| `worker_vars` | `CF_ACCESS_*` production vars |

## Feature flags

| Variable | Default | Purpose |
| --- | --- | --- |
| `create_d1` / `create_kv` / `create_r2` / `create_queue` | `true` | Toggle data-plane resources |
| `attach_queue_consumer` | `false` | Attach after Worker exists |
| `enable_access` | `true` | Toggle Access resources |

## Out of scope

- Creating the WorkOS OIDC client itself
- Durable Object / Workflow / Analytics Engine provisioning
- Automatically rewriting `wrangler.jsonc`
