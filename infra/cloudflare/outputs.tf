output "d1_database_id" {
  description = "Paste into wrangler.jsonc d1_databases[0].database_id."
  value       = var.create_d1 ? cloudflare_d1_database.tstodon[0].id : null
}

output "r2_media_bucket_name" {
  description = "Paste into wrangler.jsonc r2_buckets MEDIA bucket_name."
  value       = var.create_r2 ? cloudflare_r2_bucket.media[0].name : null
}

output "outbox_queue_name" {
  description = "Paste into wrangler.jsonc queues producers/consumers queue name."
  value       = var.create_queue ? cloudflare_queue.outbox_process[0].queue_name : null
}

output "outbox_dlq_name" {
  description = "Paste into wrangler.jsonc queues producers OUTBOX_DLQ queue name."
  value       = var.create_queue ? cloudflare_queue.outbox_dlq[0].queue_name : null
}

output "wrangler_bindings" {
  description = "Values to copy into wrangler.jsonc for production bindings."
  value = {
    d1_database_name          = var.create_d1 ? cloudflare_d1_database.tstodon[0].name : null
    d1_database_id            = var.create_d1 ? cloudflare_d1_database.tstodon[0].id : null
    r2_media_bucket_name      = var.create_r2 ? cloudflare_r2_bucket.media[0].name : null
    outbox_process_queue_name = var.create_queue ? cloudflare_queue.outbox_process[0].queue_name : null
    outbox_dlq_name           = var.create_queue ? cloudflare_queue.outbox_dlq[0].queue_name : null
  }
}

output "access_aud" {
  description = "Set as the Worker var CF_ACCESS_AUD."
  value       = var.create_access ? cloudflare_zero_trust_access_application.browser[0].aud : null
}

output "media_public_base_url" {
  description = "Set as the Worker var MEDIA_PUBLIC_BASE_URL."
  value       = var.media_hostname != "" ? "https://${var.media_hostname}" : null
}
