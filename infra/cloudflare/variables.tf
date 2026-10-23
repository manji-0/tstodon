variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the Worker resources."
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
