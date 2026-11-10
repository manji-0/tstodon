variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the Worker resources."
}

variable "create_d1" {
  type        = bool
  description = "Create the D1 database bound as DB."
  default     = true
}

variable "create_r2" {
  type        = bool
  description = "Create the R2 bucket bound as MEDIA."
  default     = true
}

variable "create_queue" {
  type        = bool
  description = "Create the outbox process Queue and its dead-letter queue."
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

variable "outbox_dlq_name" {
  type        = string
  description = "Dead-letter queue of the outbox queue (OUTBOX_DLQ; `deadLetterQueue` in app/queues/tstodon-outbox-process.ts)."
  default     = "tstodon-outbox-dlq"
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

variable "dlq_consumer_batch_size" {
  type        = number
  description = "Dead-letter queue consumer max_batch_size (maxBatchSize in app/queues/tstodon-outbox-dlq.ts)."
  default     = 10
}

variable "dlq_consumer_max_retries" {
  type        = number
  description = "Dead-letter queue consumer max_retries (maxRetries in app/queues/tstodon-outbox-dlq.ts)."
  default     = 5
}

variable "dlq_consumer_max_wait_time_ms" {
  type        = number
  description = "Dead-letter queue consumer max wait time in milliseconds (maxBatchTimeout in app/queues/tstodon-outbox-dlq.ts, in ms)."
  default     = 5000
}

# --- Hostnames ---

variable "instance_hostname" {
  type        = string
  description = "Hostname of INSTANCE_PUBLIC_ORIGIN (no scheme), e.g. social.example.com. Needed by Access and the default media CORS origin."
  default     = ""
}

variable "zone_id" {
  type        = string
  description = "Zone that holds media_hostname (for the R2 custom domain)."
  default     = ""
}

# --- Media hostname (R2 custom domain + CORS) ---

variable "media_hostname" {
  type        = string
  description = "Public hostname of the media bucket (MEDIA_PUBLIC_BASE_URL without the scheme), e.g. media.example.com. Empty: no custom domain or CORS policy."
  default     = ""
}

variable "media_cors_allowed_origins" {
  type        = list(string)
  description = "Origins allowed to read the media hostname from a browser. Empty: https://<instance_hostname>."
  default     = []
}

# --- Cloudflare Access ---

variable "create_access" {
  type        = bool
  description = "Create the Access applications: sign-in on the instance hostname, bypass on the federation, API and media paths."
  default     = false
}

variable "access_application_name" {
  type        = string
  description = "Name of the sign-in Access application (the bypass application and policies are named after it)."
  default     = "tstodon"
}

variable "access_allow_everyone" {
  type        = bool
  description = "Let anyone who signs in with an allowed identity provider through Access (open registrations; REGISTRATIONS_OPEN / REGISTRATION_APPROVAL still apply)."
  default     = false
}

variable "access_allowed_emails" {
  type        = list(string)
  description = "Email addresses allowed to sign in."
  default     = []
}

variable "access_allowed_email_domains" {
  type        = list(string)
  description = "Email domains allowed to sign in, e.g. example.com."
  default     = []
}

variable "access_allowed_idps" {
  type        = list(string)
  description = "Identity provider ids the sign-in application offers. Empty: every provider of the Zero Trust organization. With exactly one, Access redirects to it without a picker."
  default     = []
}

variable "access_session_duration" {
  type        = string
  description = "Access session lifetime. Account move, session end and app revoke take effect at the next sign-in, so keep it short."
  default     = "24h"
}
