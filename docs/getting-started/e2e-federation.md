# Federation e2e (process-compose)

<!-- constrained-by ../planning/open-todos.md -->
<!-- constrained-by ../architecture/d1-heavy-scenarios.md -->

## Goal

Run **two local tstodon Workers** and check federation discovery surfaces against each other (WebFinger, actor documents, cross-origin fetch). Expand to Follow/Create delivery scenarios next (`docs/planning/open-todos.md` E2E-2/E2E-3).

## Prerequisites

- Node 24+, pnpm
- [process-compose](https://github.com/F1bonacc1/process-compose) (add via `devbox` or install locally)
- `pnpm install` at repo root

## Local federation knobs

| Var                      | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `INSTANCE_PUBLIC_ORIGIN` | Absolute origin for actor/inbox URLs (`http://127.0.0.1:8791`) |
| `INSTANCE_DOMAIN`        | acct domain (`127.0.0.1:8791`)                                 |
| `FEDERATION_ALLOW_HOSTS` | Comma hosts that bypass private-IP SSRF block (`127.0.0.1`)    |

Configs: `e2e/instances/a.wrangler.jsonc`, `e2e/instances/b.wrangler.jsonc`.

## Commands

```sh
# apply migrations into each local persist dir (first run)
pnpm exec wrangler d1 migrations apply tstodon-e2e-a --local --config e2e/instances/a.wrangler.jsonc --persist-to .wrangler/e2e-a
pnpm exec wrangler d1 migrations apply tstodon-e2e-b --local --config e2e/instances/b.wrangler.jsonc --persist-to .wrangler/e2e-b

# bring up A+B and run smoke
process-compose up
# or: process-compose up e2e-federation-smoke

# smoke alone (instances already up)
pnpm e2e:federation
```

## Smoke coverage today

1. Nodeinfo readiness on A and B
2. Access JWT provision of alice@A / bob@B
3. WebFinger subjects for both domains
4. Actor documents use `INSTANCE_PUBLIC_ORIGIN`
5. Cross-instance HTTP GET of the remote actor JSON

Not yet: signed Follow/Accept, Create delivery, Undo, Announce, shared-inbox fan-out.
