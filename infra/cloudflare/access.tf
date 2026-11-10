# Cloudflare Access in front of the browser paths (deploy checklist step 4).
#
# Two self-hosted applications on the instance hostname:
#
# - `browser` covers the whole hostname and lets in whoever
#   `access_allowed_*` names. The Worker reads its JWT (`CF_ACCESS_AUD` is
#   this application's `aud`, output `access_aud`).
# - `federation` is more specific, so Access prefers it on its paths, and
#   bypasses Access there: remote servers, API clients and media readers
#   never carry an Access cookie.
#
# Needs a Zero Trust organization (its team domain is `CF_ACCESS_TEAM_DOMAIN`)
# and an API token with Access: Apps and Policies Edit.

locals {
  access_bypass_paths = [
    "api/*",
    "oauth/token",
    "oauth/revoke",
    ".well-known/*",
    "users/*",
    "inbox",
    "actor",
    "actor/*",
    "nodeinfo",
    "nodeinfo/*",
    "media/*",
    "attachments/*",
    "avatars/*",
    "headers/*",
  ]

  access_allow_everyone = var.access_allow_everyone ? ["everyone"] : []

  access_allow_include = concat(
    [for _ in local.access_allow_everyone : { everyone = {} }],
    [for email in var.access_allowed_emails : { email = { email = email } }],
    [for domain in var.access_allowed_email_domains : { email_domain = { domain = domain } }],
  )
}

resource "cloudflare_zero_trust_access_policy" "browser_allow" {
  count = var.create_access ? 1 : 0

  account_id       = var.account_id
  name             = "${var.access_application_name} sign-in"
  decision         = "allow"
  include          = local.access_allow_include
  session_duration = var.access_session_duration

  lifecycle {
    precondition {
      condition     = length(local.access_allow_include) > 0
      error_message = "create_access needs access_allow_everyone, access_allowed_emails or access_allowed_email_domains."
    }
    precondition {
      condition     = var.instance_hostname != ""
      error_message = "create_access needs instance_hostname."
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "federation_bypass" {
  count = var.create_access ? 1 : 0

  account_id = var.account_id
  name       = "${var.access_application_name} federation and API bypass"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "browser" {
  count = var.create_access ? 1 : 0

  account_id                = var.account_id
  name                      = var.access_application_name
  type                      = "self_hosted"
  domain                    = var.instance_hostname
  session_duration          = var.access_session_duration
  allowed_idps              = length(var.access_allowed_idps) > 0 ? var.access_allowed_idps : null
  auto_redirect_to_identity = length(var.access_allowed_idps) == 1
  app_launcher_visible      = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.browser_allow[0].id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_application" "federation" {
  count = var.create_access ? 1 : 0

  account_id           = var.account_id
  name                 = "${var.access_application_name} federation and API"
  type                 = "self_hosted"
  app_launcher_visible = false

  destinations = [for path in local.access_bypass_paths : {
    type = "public"
    uri  = "${var.instance_hostname}/${path}"
  }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.federation_bypass[0].id
    precedence = 1
  }]
}
