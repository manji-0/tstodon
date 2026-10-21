# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

1. Provision Cloudflare resources with [`infra/cloudflare`](../../infra/cloudflare/README.md) (`tofu apply`): D1, KV, R2, Queue, then Access.
2. Copy `tofu output -json wrangler_bindings` into production `wrangler.jsonc` (replace placeholder D1 / KV / R2 / queue identifiers).
3. Copy `tofu output -json worker_vars` into production Worker vars. Clear local fixture vars (`CF_ACCESS_JWKS_JSON`, `CF_ACCESS_LOCAL_PRIVATE_JWK`).
4. Confirm Access path coverage matches [Configuration](../reference/configuration.md#federation-path-policy-ops) (`/api*` protected; `/.well-known*`, `/nodeinfo*`, `/users*`, `/healthz*` bypassed).
5. Put the Web Push key as a secret, once: `wrangler secret put VAPID_PRIVATE_JWK` (see [Web Push](../reference/configuration.md#web-push)); optionally set `VAPID_SUBJECT`.
6. Apply D1 migrations: `wrangler d1 migrations apply tstodon --remote`.
7. Put the media bucket on a public hostname and set `MEDIA_PUBLIC_BASE_URL`.
8. `pnpm run ci`
9. `pnpm run deploy` (`vp build .` then `wrangler deploy`, which deploys the Vite build output in `dist/`)
10. Re-apply Terraform with `attach_queue_consumer = true` so the outbox Queue consumer points at the deployed Worker.

Do not commit Access audience values as secrets in git beyond what ops needs, and never commit private JWKs for production. Confirm the Worker placement region still matches the D1 primary.
