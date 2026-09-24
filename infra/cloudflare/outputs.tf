output "access_application_aud" {
  description = "Set Worker var CF_ACCESS_AUD to this value in production."
  value       = var.enable_access ? cloudflare_zero_trust_access_application.api[0].aud : null
}

output "access_application_id" {
  description = "Access application ID for the protected /api* surface."
  value       = var.enable_access ? cloudflare_zero_trust_access_application.api[0].id : null
}

output "cf_access_team_domain" {
  description = "Set Worker var CF_ACCESS_TEAM_DOMAIN to this value."
  value       = var.enable_access ? trimsuffix(var.team_domain, "/") : null
}

output "cf_access_admin_groups" {
  description = "Set Worker var CF_ACCESS_ADMIN_GROUPS to this comma-separated list."
  value       = join(",", var.admin_groups)
}

output "workos_idp_id" {
  description = "Access identity provider ID for the WorkOS OIDC connector."
  value       = local.idp_id
}

output "workos_redirect_uri" {
  description = "Configure this redirect URI on the WorkOS OIDC / AuthKit application."
  value       = var.enable_access ? "${trimsuffix(var.team_domain, "/")}/cdn-cgi/access/callback" : null
}

output "worker_vars" {
  description = "Suggested production Worker vars (clear CF_ACCESS_JWKS_JSON and CF_ACCESS_LOCAL_PRIVATE_JWK)."
  value = var.enable_access ? {
    CF_ACCESS_TEAM_DOMAIN       = trimsuffix(var.team_domain, "/")
    CF_ACCESS_AUD               = cloudflare_zero_trust_access_application.api[0].aud
    CF_ACCESS_ADMIN_GROUPS      = join(",", var.admin_groups)
    CF_ACCESS_JWKS_URL          = ""
    CF_ACCESS_JWKS_JSON         = ""
    CF_ACCESS_LOCAL_PRIVATE_JWK = ""
  } : null
}

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

output "r2_media_private_bucket_name" {
  description = "Paste into wrangler.jsonc r2_buckets MEDIA_PRIVATE bucket_name. Do not attach a public hostname."
  value       = var.create_r2 ? cloudflare_r2_bucket.media_private[0].name : null
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
    r2_media_bucket_name         = var.create_r2 ? cloudflare_r2_bucket.media[0].name : null
    r2_media_private_bucket_name = var.create_r2 ? cloudflare_r2_bucket.media_private[0].name : null
    outbox_process_queue_name    = var.create_queue ? cloudflare_queue.outbox_process[0].queue_name : null
  }
}
