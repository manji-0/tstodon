# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

1. Replace placeholder D1, KV, and R2 identifiers in `wrangler.jsonc`.
2. Create the `tstodon-outbox-process` queue if it does not exist.
3. Provision Cloudflare Access with the Terraform skeleton in [`infra/cloudflare-access`](../../infra/cloudflare-access/README.md) (WorkOS OIDC IdP, `/api*` Allow, federation/health Bypass). Copy `terraform output -json worker_vars` into production Worker vars. Clear local fixture vars (`CF_ACCESS_JWKS_JSON`, `CF_ACCESS_LOCAL_PRIVATE_JWK`).
4. Confirm Access path coverage matches [Configuration](../reference/configuration.md#federation-path-policy-ops) (`/api*` protected; `/.well-known*`, `/nodeinfo*`, `/users*`, `/healthz*` bypassed).
5. Apply D1 migrations: `wrangler d1 migrations apply tstodon --remote`.
6. Put the media bucket on a public hostname and set `MEDIA_PUBLIC_BASE_URL`.
7. `pnpm run ci`
8. `wrangler deploy`

Do not commit Access audience values as secrets in git beyond what ops needs, and never commit private JWKs for production. Confirm the Worker placement region still matches the D1 primary.
