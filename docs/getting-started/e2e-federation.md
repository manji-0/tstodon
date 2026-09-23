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

Configs: `e2e/a.wrangler.jsonc`, `e2e/b.wrangler.jsonc`.

## Commands

```sh
# apply migrations into each local persist dir (first run)
pnpm exec wrangler d1 migrations apply tstodon-e2e-a --local --config e2e/a.wrangler.jsonc --persist-to .wrangler/e2e-a
pnpm exec wrangler d1 migrations apply tstodon-e2e-b --local --config e2e/b.wrangler.jsonc --persist-to .wrangler/e2e-b

# bring up A+B and run smoke
process-compose up
# or: process-compose up e2e-federation-smoke

# smoke alone (instances already up)
pnpm e2e:federation
```

## Scenarios

| Script                | Command                                   | Coverage                                                                               |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Smoke                 | `pnpm e2e:federation`                     | Nodeinfo, provision, WebFinger, actor docs, host cross-fetch                           |
| Follow→Create         | `pnpm e2e:federation:follow-create`       | Signed Follow into A; ExpandFollowers outbox target; Create into B → `remote_statuses` |
| Interactions          | `pnpm e2e:federation:interactions`        | Undo Follow; Like; Announce; Undo Like (+ count asserts)                               |
| Delete + shared inbox | `pnpm e2e:federation:delete-shared-inbox` | Shared-inbox fan-out target; Create via `/inbox`; Delete clears `remote_statuses`      |

### Local peer fetch

Actor resolution still pre-seeds `remote_actors` to avoid fragile loopback GETs during signature setup. Outbound **Create/Accept delivery** prefers the Worker workflow path and only falls back to a host-driven signed POST if the peer note/accept never appears. See `e2e/federation-*.mjs`.
