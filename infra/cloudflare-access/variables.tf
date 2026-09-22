variable "account_id" {
  type        = string
  description = "Cloudflare account ID that owns the Zero Trust / Access configuration."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for the public hostname (optional if using account-owned destinations only)."
  default     = null
}

variable "hostname" {
  type        = string
  description = "Public hostname serving the tstodon Worker, e.g. social.example.com."
}

variable "team_domain" {
  type        = string
  description = "Zero Trust team domain including scheme, e.g. https://myteam.cloudflareaccess.com. Becomes CF_ACCESS_TEAM_DOMAIN."
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
  description = "When false, skip creating the OIDC IdP and attach an existing IdP id via existing_idp_id."
  default     = true
}

variable "existing_idp_id" {
  type        = string
  description = "Existing Access identity provider ID when create_workos_idp is false."
  default     = null
}
