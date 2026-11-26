# Clone And Run

## Install

<!-- constrained-by ./development.md -->

```sh
pnpm install
pnpm types:worker
```

`pnpm types:worker` generates `packages/worker/worker-configuration.d.ts` from the Worker's Cloudflare config (`cloudflare` in `packages/worker/void.config.ts`). Do not hand-write `Env`.

## Verify

```sh
pnpm test
pnpm typecheck
```

## Run locally

<!-- constrained-by ../reference/configuration.md#local-development-authentication -->

```sh
pnpm dev
```

Then:

- [http://localhost:5173/healthz](http://localhost:5173/healthz)
- [http://localhost:5173/api/v1/instance](http://localhost:5173/api/v1/instance)

Local API authentication in tests seeds a Better Auth user, its account, and an OAuth access token in D1 via `packages/worker/test/auth-fixture.ts` and sends `Authorization: Bearer …`; admin coverage sets the Better Auth `admin` role. In `pnpm dev`, browser login is Cloudflare Access (see [Local development authentication](../reference/configuration.md#local-development-authentication)): `/auth/sign_in` does not create a passkey. The instance is single-user by default (`SINGLE_USER_MODE`), so the first Access login creates the owner's admin account and no later email gets one; set `SINGLE_USER_MODE=false` in `packages/worker/.env` to try several accounts ([Single-user mode](../reference/configuration.md#single-user-mode)). A signed-in session authorizes a Mastodon client at `/oauth/authorize`. `pnpm dev` needs no local secret file. For local overrides, put them in `packages/worker/.env` (gitignored; the secrets are declared in `packages/worker/app/env.ts`, and any other line overrides a var from `void.config.ts` under `pnpm dev`). Replace placeholder D1 / R2 / Queue identifiers under `cloudflare` in `packages/worker/void.config.ts` before a real deploy. See [Configuration](../reference/configuration.md#authentication) and [Local Core](../planning/local-core.md).
