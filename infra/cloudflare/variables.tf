variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns Access and Worker resources."
}

variable "enable_access" {
  type        = bool
  description = "Create Cloudflare Access IdP / apps / policies for the Worker hostname."
  default     = true
}

variable "create_d1" {
  type        = bool
  description = "Create the D1 database bound as DB."
  default     = true
}

variable "create_kv" {
  type        = bool
  description = "Create KV namespaces bound as REMOTE_DNS_CACHE and APP_CACHE."
  default     = true
}

variable "create_r2" {
  type        = bool
  description = "Create the R2 bucket bound as MEDIA."
  default     = true
}

variable "create_queue" {
  type        = bool
  description = "Create the outbox process Queue."
  default     = true
}

variable "d1_database_name" {
  type        = string
  description = "D1 database name (wrangler database_name)."
  default     = "tstodon"
}

variable "d1_primary_location_hint" {
  type        = string
  description = "D1 primary location hint. Align with Worker placement when possible (apac ≈ ap-southeast-1)."
  default     = "apac"
}

variable "kv_remote_dns_cache_title" {
  type        = string
  description = "KV namespace title for REMOTE_DNS_CACHE."
  default     = "tstodon-remote-dns-cache"
}

variable "kv_app_cache_title" {
  type        = string
  description = "KV namespace title for APP_CACHE."
  default     = "tstodon-app-cache"
}

variable "r2_media_bucket_name" {
  type        = string
  description = "R2 bucket name for MEDIA."
  default     = "tstodon-media"
}

variable "outbox_queue_name" {
  type        = string
  description = "Queue name for OUTBOX_PROCESS_QUEUE."
  default     = "tstodon-outbox-process"
}

variable "worker_script_name" {
  type        = string
  description = "Worker script name used when attaching the queue consumer (wrangler name)."
  default     = "tstodon"
}

variable "attach_queue_consumer" {
  type        = bool
  description = "Attach a Worker consumer to the outbox queue. Enable after the Worker script exists."
  default     = false
}

variable "queue_consumer_batch_size" {
  type        = number
  description = "Queue consumer max_batch_size."
  default     = 10
}

variable "queue_consumer_max_retries" {
  type        = number
  description = "Queue consumer max_retries."
  default     = 3
}

variable "queue_consumer_max_concurrency" {
  type        = number
  description = "Queue consumer max_concurrency."
  default     = 1
}

variable "queue_consumer_max_wait_time_ms" {
  type        = number
  description = "Queue consumer max wait time in milliseconds (wrangler max_batch_timeout)."
  default     = 0
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for the public hostname (optional if using account-owned destinations only)."
  default     = null
}

variable "hostname" {
  type        = string
  description = "Public hostname serving the tstodon Worker, e.g. social.example.com. Required when enable_access is true."
  default     = null
}

variable "team_domain" {
  type        = string
  description = "Zero Trust team domain including scheme, e.g. https://myteam.cloudflareaccess.com. Required when enable_access is true."
  default     = null
}

variable "session_duration" {
  type        = string
  description = "Access session duration for the protected API application."
  default     = "24h"
}

variable "admin_groups" {
  type        = list(string)
  description = "IdP / Access group names that map to FediRole Admin in the Worker (CF_ACCESS_ADMIN_GROUPS)."
  default     = ["tstodon-admins"]
}

variable "allowed_email_domains" {
  type        = list(string)
  description = "Email domains allowed by the Access Allow policy (e.g. example.com). Empty allows any authenticated IdP user."
  default     = []
}

variable "workos_oidc" {
  type = object({
    client_id     = string
    client_secret = string
    auth_url      = string
    token_url     = string
    certs_url     = string
    scopes        = optional(list(string), ["openid", "email", "profile"])
    claims        = optional(list(string), ["groups", "email"])
    pkce_enabled  = optional(bool, true)
  })
  description = <<-EOT
    WorkOS OIDC client used as the Access identity provider.
    Required when create_workos_idp is true.
    Copy auth_url / token_url / certs_url from the WorkOS (AuthKit) OIDC discovery document.
    Redirect URI configured in WorkOS must be:
      https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback
  EOT
  default     = null
  sensitive   = true
}

variable "create_workos_idp" {
  type        = bool
  description = "When false (and enable_access is true), skip creating the OIDC IdP and attach an existing IdP id via existing_idp_id."
  default     = true
}

variable "existing_idp_id" {
  type        = string
  description = "Existing Access identity provider ID when create_workos_idp is false."
  default     = null
}
