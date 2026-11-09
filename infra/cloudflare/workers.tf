# Worker data-plane resources referenced by wrangler.jsonc bindings.
# Durable Objects / Workflows / Analytics Engine stay owned by wrangler deploy.

resource "cloudflare_d1_database" "tstodon" {
  count = var.create_d1 ? 1 : 0

  account_id            = var.account_id
  name                  = var.d1_database_name
  primary_location_hint = var.d1_primary_location_hint
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

# The outbox queue's dead-letter queue: messages the outbox consumer gives up
# on land here, and its own consumer stores them in D1 (`outbox_dead_jobs`).
resource "cloudflare_queue" "outbox_dlq" {
  count = var.create_queue ? 1 : 0

  account_id = var.account_id
  queue_name = var.outbox_dlq_name
}

# Attach after the Worker script exists (first `wrangler deploy`). These
# mirror what `wrangler deploy` writes from `packages/worker/app/queues/*.ts`;
# keep the settings equal to the exports there.
resource "cloudflare_queue_consumer" "outbox_process" {
  count = var.create_queue && var.attach_queue_consumer ? 1 : 0

  account_id        = var.account_id
  queue_id          = cloudflare_queue.outbox_process[0].id
  script_name       = var.worker_script_name
  type              = "worker"
  dead_letter_queue = cloudflare_queue.outbox_dlq[0].queue_name

  settings = {
    batch_size       = var.queue_consumer_batch_size
    max_retries      = var.queue_consumer_max_retries
    max_concurrency  = var.queue_consumer_max_concurrency
    max_wait_time_ms = var.queue_consumer_max_wait_time_ms
  }
}

resource "cloudflare_queue_consumer" "outbox_dlq" {
  count = var.create_queue && var.attach_queue_consumer ? 1 : 0

  account_id  = var.account_id
  queue_id    = cloudflare_queue.outbox_dlq[0].id
  script_name = var.worker_script_name
  type        = "worker"

  settings = {
    batch_size       = var.dlq_consumer_batch_size
    max_retries      = var.dlq_consumer_max_retries
    max_concurrency  = 1
    max_wait_time_ms = var.dlq_consumer_max_wait_time_ms
  }
}
