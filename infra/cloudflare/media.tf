# The media bucket's public hostname and its CORS policy (deploy checklist
# steps 7 and 8). Set `media_hostname` to the origin `MEDIA_PUBLIC_BASE_URL`
# names; leave it empty to serve media from the Worker origin instead.

locals {
  media_bucket_name = var.create_r2 ? cloudflare_r2_bucket.media[0].name : var.r2_media_bucket_name
  media_cors_allowed_origins = length(var.media_cors_allowed_origins) > 0 ? var.media_cors_allowed_origins : (
    var.instance_hostname != "" ? ["https://${var.instance_hostname}"] : []
  )
}

resource "cloudflare_r2_custom_domain" "media" {
  count = var.media_hostname != "" ? 1 : 0

  account_id  = var.account_id
  bucket_name = local.media_bucket_name
  domain      = var.media_hostname
  zone_id     = var.zone_id
  enabled     = true
  min_tls     = "1.2"

  lifecycle {
    precondition {
      condition     = var.zone_id != ""
      error_message = "media_hostname needs zone_id (the zone the hostname belongs to)."
    }
  }
}

# Browser reads of the media hostname (the web UI's fetches and video range
# requests). The Worker's own media routes send their CORS headers themselves.
resource "cloudflare_r2_bucket_cors" "media" {
  count = var.media_hostname != "" ? 1 : 0

  account_id  = var.account_id
  bucket_name = local.media_bucket_name

  rules = [{
    allowed = {
      origins = local.media_cors_allowed_origins
      methods = ["GET", "HEAD"]
      headers = ["Range", "If-None-Match", "If-Modified-Since"]
    }
    expose_headers  = ["ETag", "Content-Length", "Content-Type", "Content-Range", "Accept-Ranges"]
    max_age_seconds = 86400
  }]

  lifecycle {
    precondition {
      condition     = length(local.media_cors_allowed_origins) > 0
      error_message = "media_hostname needs instance_hostname or media_cors_allowed_origins for the CORS policy."
    }
  }
}
