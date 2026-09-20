# Clone And Run

## Install
<!-- constrained-by ./development.md -->

```sh
pnpm install
pnpm types:worker
```

`pnpm types:worker` generates `worker-configuration.d.ts` from `wrangler.jsonc`. Do not hand-write `Env`.

## Verify

```sh
pnpm test
pnpm typecheck
```

## Run locally

```sh
pnpm dev
```

Then:

- [http://127.0.0.1:8787/healthz](http://127.0.0.1:8787/healthz)
- [http://127.0.0.1:8787/api/v1/instance](http://127.0.0.1:8787/api/v1/instance)

Local API authentication uses `Authorization: Bearer ${DEV_BEARER_SECRET}:${email}` (default secret `dev-secret`). Copy `.dev.vars.example` to `.dev.vars` before enabling Auth0-protected routes. Replace placeholder D1 / KV / R2 identifiers in `wrangler.jsonc` before a real deploy. See [Configuration](../reference/configuration.md).
