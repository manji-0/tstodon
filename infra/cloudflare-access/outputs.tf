output "access_application_aud" {
  description = "Set Worker var CF_ACCESS_AUD to this value in production."
  value       = cloudflare_zero_trust_access_application.api.aud
}

output "access_application_id" {
  description = "Access application ID for the protected /api* surface."
  value       = cloudflare_zero_trust_access_application.api.id
}

output "cf_access_team_domain" {
  description = "Set Worker var CF_ACCESS_TEAM_DOMAIN to this value."
  value       = trimsuffix(var.team_domain, "/")
}

output "cf_access_admin_groups" {
  description = "Set Worker var CF_ACCESS_ADMIN_GROUPS to this comma-separated list."
  value       = join(",", var.admin_groups)
}

output "workos_idp_id" {
  description = "Access identity provider ID for the WorkOS OIDC connector."
  value       = local.idp_id
}

output "worker_vars" {
  description = "Suggested production Worker vars (clear CF_ACCESS_JWKS_JSON and CF_ACCESS_LOCAL_PRIVATE_JWK)."
  value = {
    CF_ACCESS_TEAM_DOMAIN       = trimsuffix(var.team_domain, "/")
    CF_ACCESS_AUD               = cloudflare_zero_trust_access_application.api.aud
    CF_ACCESS_ADMIN_GROUPS      = join(",", var.admin_groups)
    CF_ACCESS_JWKS_URL          = ""
    CF_ACCESS_JWKS_JSON         = ""
    CF_ACCESS_LOCAL_PRIVATE_JWK = ""
  }
}

output "workos_redirect_uri" {
  description = "Configure this redirect URI on the WorkOS OIDC / AuthKit application."
  value       = "${trimsuffix(var.team_domain, "/")}/cdn-cgi/access/callback"
}
