# Worker data-plane resources referenced by wrangler.jsonc bindings.
# Durable Objects / Workflows / Analytics Engine stay owned by wrangler deploy.

resource "cloudflare_d1_database" "tstodon" {
  count = var.create_d1 ? 1 : 0

  account_id            = var.account_id
  name                  = var.d1_database_name
  primary_location_hint = var.d1_primary_location_hint
}

resource "cloudflare_workers_kv_namespace" "remote_dns_cache" {
  count = var.create_kv ? 1 : 0

  account_id = var.account_id
  title      = var.kv_remote_dns_cache_title
}

resource "cloudflare_workers_kv_namespace" "app_cache" {
  count = var.create_kv ? 1 : 0

  account_id = var.account_id
  title      = var.kv_app_cache_title
}

resource "cloudflare_r2_bucket" "media" {
  count = var.create_r2 ? 1 : 0

  account_id = var.account_id
  name       = var.r2_media_bucket_name
}

resource "cloudflare_queue" "outbox_process" {
  count = var.create_queue ? 1 : 0

  account_id = var.account_id
  queue_name = var.outbox_queue_name
}

# Attach after the Worker script exists (first `wrangler deploy`).
resource "cloudflare_queue_consumer" "outbox_process" {
  count = var.create_queue && var.attach_queue_consumer ? 1 : 0

  account_id  = var.account_id
  queue_id    = cloudflare_queue.outbox_process[0].id
  script_name = var.worker_script_name
  type        = "worker"

  settings = {
    batch_size       = var.queue_consumer_batch_size
    max_retries      = var.queue_consumer_max_retries
    max_concurrency  = var.queue_consumer_max_concurrency
    max_wait_time_ms = var.queue_consumer_max_wait_time_ms
  }
}
