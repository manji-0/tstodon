# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

1. Replace placeholder D1, KV, and R2 identifiers in `wrangler.jsonc`.
2. Create the `tstodon-outbox-process` queue if it does not exist.
3. Set Auth0 vars and any secrets (`wrangler secret put`).
4. Apply D1 migrations: `wrangler d1 migrations apply tstodon --remote`.
5. Put the media bucket on a public hostname and set `MEDIA_PUBLIC_BASE_URL`.
6. `pnpm ci`
7. `wrangler deploy`

Do not commit secrets. Confirm the Worker placement region still matches the D1 primary.
