locals {
  idp_id = var.create_workos_idp ? cloudflare_zero_trust_access_identity_provider.workos[0].id : var.existing_idp_id

  # Prefer email-domain Allow rules when configured; otherwise Allow any authenticated user.
  allow_include = length(var.allowed_email_domains) > 0 ? [
    for domain in var.allowed_email_domains : {
      email_domain = { domain = domain }
    }
    ] : [
    {
      everyone = {}
    }
  ]

  federation_bypass = {
    well_known = "${var.hostname}/.well-known*"
    nodeinfo   = "${var.hostname}/nodeinfo*"
    users      = "${var.hostname}/users*"
    healthz    = "${var.hostname}/healthz*"
  }
}

check "idp_selection" {
  assert {
    condition     = var.create_workos_idp || (var.existing_idp_id != null && var.existing_idp_id != "")
    error_message = "Set create_workos_idp=true or provide existing_idp_id."
  }
}

check "workos_oidc_required" {
  assert {
    condition     = !var.create_workos_idp || var.workos_oidc != null
    error_message = "workos_oidc is required when create_workos_idp is true."
  }
}

resource "cloudflare_zero_trust_access_identity_provider" "workos" {
  count = var.create_workos_idp ? 1 : 0

  account_id = var.account_id
  name       = "WorkOS (tstodon)"
  type       = "oidc"

  config = {
    client_id        = var.workos_oidc.client_id
    client_secret    = var.workos_oidc.client_secret
    auth_url         = var.workos_oidc.auth_url
    token_url        = var.workos_oidc.token_url
    certs_url        = var.workos_oidc.certs_url
    pkce_enabled     = var.workos_oidc.pkce_enabled
    email_claim_name = "email"
    claims           = var.workos_oidc.claims
    scopes           = var.workos_oidc.scopes
  }
}

# Reusable Allow: authenticated users (optionally restricted by email domain).
resource "cloudflare_zero_trust_access_policy" "allow_authenticated" {
  account_id = var.account_id
  name       = "tstodon-allow-authenticated"
  decision   = "allow"
  include    = local.allow_include
}

# Reusable Bypass: anyone (federation / health paths only).
resource "cloudflare_zero_trust_access_policy" "bypass_public" {
  account_id = var.account_id
  name       = "tstodon-bypass-public"
  decision   = "bypass"
  include = [{
    everyone = {}
  }]
}

# Protect Mastodon / private HTTP API.
resource "cloudflare_zero_trust_access_application" "api" {
  account_id                = var.zone_id == null ? var.account_id : null
  zone_id                   = var.zone_id
  name                      = "tstodon-api"
  type                      = "self_hosted"
  session_duration          = var.session_duration
  allowed_idps              = [local.idp_id]
  auto_redirect_to_identity = true

  destinations = [{
    type = "public"
    uri  = "${var.hostname}/api*"
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.allow_authenticated.id
    precedence = 1
  }]
}

# Public federation + health paths: explicit Bypass apps so intent is visible in Zero Trust.
resource "cloudflare_zero_trust_access_application" "federation_bypass" {
  for_each = local.federation_bypass

  account_id       = var.zone_id == null ? var.account_id : null
  zone_id          = var.zone_id
  name             = "tstodon-bypass-${each.key}"
  type             = "self_hosted"
  session_duration = "24h"

  destinations = [{
    type = "public"
    uri  = each.value
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.bypass_public.id
    precedence = 1
  }]
}
