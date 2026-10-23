# Clone And Run

## Install

<!-- constrained-by ./development.md -->

```sh
pnpm install
pnpm types:worker
```

`pnpm types:worker` generates `packages/worker/worker-configuration.d.ts` from `packages/worker/wrangler.jsonc`. Do not hand-write `Env`.

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

Local API authentication in tests seeds a Better Auth user, its account, and an OAuth access token in D1 via `packages/worker/test/auth-fixture.ts` and sends `Authorization: Bearer …`; admin coverage sets the Better Auth `admin` role. In `pnpm dev`, sign up with a passkey at `http://localhost:<port>/auth/sign_up`, then authorize a Mastodon client against `/oauth/authorize`. Copy `.dev.vars.example` to `.dev.vars` only if you need local overrides. Replace placeholder D1 / KV / R2 identifiers in `wrangler.jsonc` before a real deploy. See [Configuration](../reference/configuration.md#authentication) and [Local Core](../planning/local-core.md).
