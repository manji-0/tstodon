output "d1_database_id" {
  description = "Paste into wrangler.jsonc d1_databases[0].database_id."
  value       = var.create_d1 ? cloudflare_d1_database.tstodon[0].id : null
}

output "kv_remote_dns_cache_id" {
  description = "Paste into wrangler.jsonc kv_namespaces REMOTE_DNS_CACHE id."
  value       = var.create_kv ? cloudflare_workers_kv_namespace.remote_dns_cache[0].id : null
}

output "kv_app_cache_id" {
  description = "Paste into wrangler.jsonc kv_namespaces APP_CACHE id."
  value       = var.create_kv ? cloudflare_workers_kv_namespace.app_cache[0].id : null
}

output "r2_media_bucket_name" {
  description = "Paste into wrangler.jsonc r2_buckets MEDIA bucket_name."
  value       = var.create_r2 ? cloudflare_r2_bucket.media[0].name : null
}

output "outbox_queue_name" {
  description = "Paste into wrangler.jsonc queues producers/consumers queue name."
  value       = var.create_queue ? cloudflare_queue.outbox_process[0].queue_name : null
}

output "wrangler_bindings" {
  description = "Values to copy into wrangler.jsonc for production bindings."
  value = {
    d1_database_name          = var.create_d1 ? cloudflare_d1_database.tstodon[0].name : null
    d1_database_id            = var.create_d1 ? cloudflare_d1_database.tstodon[0].id : null
    kv_remote_dns_cache_id    = var.create_kv ? cloudflare_workers_kv_namespace.remote_dns_cache[0].id : null
    kv_app_cache_id           = var.create_kv ? cloudflare_workers_kv_namespace.app_cache[0].id : null
    r2_media_bucket_name      = var.create_r2 ? cloudflare_r2_bucket.media[0].name : null
    outbox_process_queue_name = var.create_queue ? cloudflare_queue.outbox_process[0].queue_name : null
  }
}
