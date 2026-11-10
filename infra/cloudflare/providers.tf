provider "cloudflare" {
  # Prefer CLOUDFLARE_API_TOKEN in the environment.
  # Typical account-scoped permissions:
  # - D1 Edit, Cloudflare R2 Edit, Workers Queues Edit
  # - Workers Scripts Edit (queue consumer attach)
  # - Access: Apps and Policies Edit (create_access)
  # - Zone: Zone Read on the media zone (media_hostname; the R2 custom domain)
}
