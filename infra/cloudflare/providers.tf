provider "cloudflare" {
  # Prefer CLOUDFLARE_API_TOKEN in the environment.
  # Typical account-scoped permissions:
  # - D1 Edit, Workers KV Storage Edit, Cloudflare R2 Edit, Workers Queues Edit
  # - Workers Scripts Edit (queue consumer attach)
  # - Access: Apps and Policies Edit
  # - Access: Organizations, Identity Providers, and Groups Edit
}
