# Federation e2e (process-compose)

<!-- constrained-by ../planning/open-todos.md -->
<!-- constrained-by ../architecture/d1-heavy-scenarios.md -->

## Goal

Run **two local tstodon Workers** and check federation discovery surfaces against each other (WebFinger, actor documents, cross-origin fetch). Expand to Follow/Create delivery scenarios next (`docs/planning/open-todos.md` E2E-2/E2E-3).

## Prerequisites

- Node 26+, pnpm
- [process-compose](https://github.com/F1bonacc1/process-compose) (included in `nix develop`, or install locally)
- `pnpm install` at repo root

## Local federation knobs

| Var                      | Purpose                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSTANCE_PUBLIC_ORIGIN` | Absolute origin for actor/inbox URLs (`http://127.0.0.1:8791`)                                                                              |
| `INSTANCE_DOMAIN`        | acct domain (`127.0.0.1:8791`)                                                                                                              |
| `FEDERATION_ALLOW_HOSTS` | Comma hosts allowed to federate; a non-empty list is limited federation and also lifts the private-IP refusal for those hosts (`127.0.0.1`) |

Configs: `e2e/a.wrangler.jsonc`, `e2e/b.wrangler.jsonc`. Each instance runs `vp -C packages/worker dev` with `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` pointing at its config (relative to `packages/worker`; read by the Cloudflare plugin that Void wraps), `TSTODON_PERSIST_TO` at its local state relative to the repository root (`.wrangler/e2e-a`, `.wrangler/e2e-b`), which `packages/worker/vite.config.ts` passes to `voidPlugin({ persistTo })`, and `VOID_INSPECTOR_PORT=false` so the two instances do not race for the inspector port. The layout matches `wrangler --persist-to`, so the `wrangler d1` commands below and the e2e helpers read the same databases. Like the root config, the instance configs leave cron triggers and the queue consumer to `packages/worker/app`, and their producer targets the queue named by `packages/worker/app/queues/` (`tstodon-outbox-process`).

To start one instance by hand:

```sh
CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=../../e2e/a.wrangler.jsonc VOID_INSPECTOR_PORT=false TSTODON_PERSIST_TO=.wrangler/e2e-a pnpm exec vp -C packages/worker dev --port 8791 --strictPort --host 127.0.0.1
```

## Commands

```sh
# apply migrations into each local persist dir (first run)
pnpm exec wrangler d1 migrations apply tstodon-e2e-a --local --config e2e/a.wrangler.jsonc --persist-to .wrangler/e2e-a
pnpm exec wrangler d1 migrations apply tstodon-e2e-b --local --config e2e/b.wrangler.jsonc --persist-to .wrangler/e2e-b

# bring up A+B (one `vp dev` per instance) and run smoke
process-compose up
# or: process-compose up e2e-federation-smoke

# smoke alone (instances already up)
pnpm e2e:federation
```

## Scenarios

| Script                | Command                                   | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke                 | `pnpm e2e:federation`                     | Nodeinfo, provision, WebFinger, actor docs, host cross-fetch                                                                                                                                                                                                                                                                                                                                                              |
| Follow→Create         | `pnpm e2e:federation:follow-create`       | Signed Follow into A; ExpandFollowers outbox target; Create into B → `remote_statuses`                                                                                                                                                                                                                                                                                                                                    |
| Interactions          | `pnpm e2e:federation:interactions`        | Undo Follow; Like; Announce; Undo Like (+ count asserts)                                                                                                                                                                                                                                                                                                                                                                  |
| Delete + shared inbox | `pnpm e2e:federation:delete-shared-inbox` | Shared-inbox fan-out target; Create via `/inbox`; Delete clears `remote_statuses`                                                                                                                                                                                                                                                                                                                                         |
| Accept                | `pnpm e2e:federation:accept`              | Unlocked Follow enqueues targeted Accept; delivered to follower inbox                                                                                                                                                                                                                                                                                                                                                     |
| Remote follow         | `pnpm e2e:federation:remote-follow`       | A's user resolves and follows B's user (Follow → Accept, follower count on B); B's post reaches A's home, public, hashtag and list timelines and streams; Delete removes it; unfollow sends Undo                                                                                                                                                                                                                          |
| Remote updates        | `pnpm e2e:federation:remote-updates`      | Outbox backfill on A's profile view; B's boost of a third user's note as a reblog on A's home; B's edit (`edited_at`); B's poll on A, A's vote counted on B, B's `Update(Question)` back on A                                                                                                                                                                                                                             |
| Migration             | `pnpm e2e:federation:migration`           | Bob on B adds Alice on A as an alias (`/settings/aliases`); Alice moves to Bob (`/settings/migration`): `moved` on A, posting refused, B's `Move` handling moves Carol's follow to Bob, A moves Dave's local follow to a follow of Bob; Erin on B (who blocks Bob) keeps her follow of Alice; Alice cancels the redirect: B gets her actor `Update` and stops showing `moved`, Alice posts again, Carol still follows Bob |
| Reports               | `pnpm e2e:federation:reports`             | Alice on A reports Bob on B and his post with `forward=true`; A's instance actor delivers the `Flag`; B's admin gets the `admin.report` notification and sees the report, with Bob's post, on `/admin/reports`                                                                                                                                                                                                            |

### Local peer fetch

The first five scenarios pre-seed `remote_actors` and sign activities on the host, then accept either Worker delivery or a host-driven signed POST. The remote follow, remote updates, migration, and reports scenarios use only the client API and the server-rendered settings pages of each instance: every fetch, WebFinger lookup, and delivery between A and B runs in the Workers. Both sign up fresh users with a per-run suffix, so they rerun against the same state without a reset. The reports scenario also makes B's moderator an admin by setting `user.role` with `wrangler d1 execute` on B's local database, and reads the filed report back the same way.

The remote updates scenario waits for B's debounced `Update(Question)`. Miniflare honours queue `delaySeconds`, so with Mastodon's default of 180 seconds the step takes three minutes; `e2e/a.wrangler.jsonc` and `e2e/b.wrangler.jsonc` set `POLL_UPDATE_DELAY_SECONDS` to `5`.

Behind an HTTP proxy (`HTTPS_PROXY` set), start the instances with `NO_PROXY=127.0.0.1,localhost`. The Workers' outbound fetches use the proxy otherwise, and it cannot reach the other instance on loopback, so search finds no remote account.

### Not covered locally

- Remote accounts show a port-less `acct`: `remote_actors.domain` is the actor URL's hostname, so B's user appears on A as `@bob@127.0.0.1`, not `@bob@127.0.0.1:8792`. Production domains carry no port. The scenarios match accounts by `uri`.
