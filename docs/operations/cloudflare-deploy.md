# Cloudflare Deploy Checklist

<!-- constrained-by ../reference/configuration.md#cloudflare-bindings -->

1. Replace placeholder D1, KV, and R2 identifiers in `wrangler.jsonc`.
2. Create the `tstodon-outbox-process` queue if it does not exist.
3. Create a Cloudflare Access application on the Worker hostname. Add WorkOS as the Access IdP. Set Worker vars `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `CF_ACCESS_ADMIN_GROUPS`. Clear local fixture vars (`CF_ACCESS_JWKS_JSON`, `CF_ACCESS_LOCAL_PRIVATE_JWK`) in production.
4. Configure Access path policies: require Access for `/api/*`; bypass federation/discovery paths (`/.well-known/*`, `/nodeinfo/*`, `/users/*`, inbox/outbox). See [Configuration](../reference/configuration.md#federation-path-policy-ops).
5. Apply D1 migrations: `wrangler d1 migrations apply tstodon --remote`.
6. Put the media bucket on a public hostname and set `MEDIA_PUBLIC_BASE_URL`.
7. `pnpm run ci`
8. `wrangler deploy`

Do not commit Access audience values as secrets in git beyond what ops needs, and never commit private JWKs for production. Confirm the Worker placement region still matches the D1 primary.
