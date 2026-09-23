# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

1. Provision Cloudflare resources with [`infra/cloudflare`](../../infra/cloudflare/README.md) (`tofu apply`): D1, KV, R2, Queue, then Access.
2. Copy `tofu output -json wrangler_bindings` into production `wrangler.jsonc` (replace placeholder D1 / KV / R2 / queue identifiers).
3. Copy `tofu output -json worker_vars` into production Worker vars. Clear local fixture vars (`CF_ACCESS_JWKS_JSON`, `CF_ACCESS_LOCAL_PRIVATE_JWK`).
4. Confirm Access path coverage matches [Configuration](../reference/configuration.md#federation-path-policy-ops) (`/api*` protected; `/.well-known*`, `/nodeinfo*`, `/users*`, `/healthz*` bypassed).
5. Apply D1 migrations: `wrangler d1 migrations apply tstodon --remote`.
6. Put the media bucket on a public hostname (R2 custom domain) and set `MEDIA_PUBLIC_BASE_URL` to that origin. Object keys under the bucket are the URL path (`attachments/…`, `avatars/…`, `headers/…`). See [Configuration — Media public URLs](../reference/configuration.md#media-public-urls).
7. Apply R2 CORS for browser reads of that hostname. Copy [`infra/cloudflare/media-cors.json.example`](../../infra/cloudflare/media-cors.json.example), set `allowed.origins` to your `INSTANCE_PUBLIC_ORIGIN` (plus any web UI origins), then:

   ```sh
   wrangler r2 bucket cors set <MEDIA_BUCKET_NAME> --file infra/cloudflare/media-cors.json
   wrangler r2 bucket cors list <MEDIA_BUCKET_NAME>
   ```

   Purge the media hostname cache after changing CORS if the domain was already live. Worker media proxy CORS is separate (`Access-Control-Allow-Origin: *` on `/media/*` and object-key routes).

8. Set optional Worker var `CORS_ALLOWED_ORIGINS` for extra browser API origins (comma-separated). `/api*` always allows `INSTANCE_PUBLIC_ORIGIN`.
9. `pnpm run ci`
10. `wrangler deploy`
11. Re-apply Terraform with `attach_queue_consumer = true` so the outbox Queue consumer points at the deployed Worker.

Do not commit Access audience values as secrets in git beyond what ops needs, and never commit private JWKs for production. Confirm the Worker placement region still matches the D1 primary.
