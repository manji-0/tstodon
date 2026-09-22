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

Local API authentication in tests mints Cloudflare Access-shaped JWTs via `packages/worker/test/access-jwt-fixture.ts` and sends them as `Authorization: Bearer …` (or `Cf-Access-Jwt-Assertion`). Admin coverage uses the fixture admin group claim. Copy `.dev.vars.example` to `.dev.vars` only if you need local overrides. Replace placeholder D1 / KV / R2 identifiers in `wrangler.jsonc` before a real deploy. See [Configuration](../reference/configuration.md) and [Local Core](../planning/local-core.md).
