# Interop e2e against a real Mastodon

<!-- constrained-by ../../docs/getting-started/e2e-federation.md -->
<!-- constrained-by ../../docs/getting-started/e2e-federation-portless.md -->
<!-- constrained-by ../../docs/reference/configuration.md#limited-federation -->

This harness runs one real Mastodon (v4.7.5) next to a local tstodon Worker and federates them over HTTPS. The other federation suites pair tstodon with tstodon, so they cannot catch a disagreement with Mastodon itself. CI runs it ([One command, and CI](#one-command-and-ci)).

## What runs

| Piece                     | Where                                           | Name                        |
| ------------------------- | ----------------------------------------------- | --------------------------- |
| Mastodon web (Puma)       | container `web`, production mode                | `https://mastodon.test`     |
| Mastodon Sidekiq          | container `sidekiq`                             |                             |
| PostgreSQL 16, Redis 7    | containers `db` (tmpfs data), `redis`           |                             |
| TLS proxy (Caddy)         | container `proxy`, published on `127.0.0.1:443` | both names                  |
| tstodon Worker (`vp dev`) | the host, `172.30.47.1:8791`                    | `https://tstodon.localhost` |

Mastodon's streaming server is not started. The scripts use the REST API only.

## Prerequisites

- Docker with Compose v2, `openssl`, `curl`.
- `pnpm install` at the repository root.
- Port 443 free on the host, and write access to `/etc/hosts` (the script uses `sudo` when it has to).

## Run it

```sh
# 1. Mastodon, the proxy, the certificates, and five users (about 25 s).
e2e/mastodon/bootstrap.sh

# 2. The tstodon Worker, in the foreground (about 90 s to the first answer).
e2e/mastodon/start-tstodon.sh

# 3. In another terminal: load the variables, then run a script.
set -a; source e2e/mastodon/.state/e2e.env; set +a
pnpm e2e:mastodon          # follow both ways, a post each way; the gate
pnpm e2e:mastodon:probe    # the sweep; reports every gap, exits 1 if any
```

`bootstrap.sh` is safe to rerun. A rerun gives each user a new token and rewrites `.state/e2e.env`. `MASTODON_VERSION` selects another image tag.

`E2E_PROBE_AREAS=search,threads pnpm e2e:mastodon:probe` runs only those areas of the sweep. The areas are `base`, `search`, `direct`, `threads`, `follows` and `authorized-fetch`.

### One command, and CI

`e2e/mastodon/ci.sh` does a whole run and leaves nothing behind:

```sh
e2e/mastodon/ci.sh
TSTODON_AUTHORIZED_FETCH=true MASTODON_AUTHORIZED_FETCH=true e2e/mastodon/ci.sh    # both in secure mode
```

1. It removes the Compose stack and the tstodon database (`.wrangler/e2e-mastodon`) that an earlier run left.
2. It runs `bootstrap.sh`, then `start-tstodon.sh` in the background, and waits for `https://tstodon.localhost`.
3. It runs `pnpm e2e:mastodon` and `pnpm e2e:mastodon:probe`. Both run even when the first fails. The script exits 1 when either fails.
4. It writes the logs to `.cache/e2e-mastodon/`: `tstodon-dev.log` (the Worker), `compose-<service>.log`, `compose-ps.txt`, `gate.log` and `sweep.log`. On a failure it also prints the last 150 lines of the Worker's, Mastodon's and the proxy's logs.
5. It stops the Worker and removes the stack and the tstodon database. With `E2E_MASTODON_KEEP=1` the stack stays up.

Do not run it beside a stack you started by hand: step 1 removes that stack. The certificates and Mastodon's secrets in `.state/`, `.dev.vars` and the `/etc/hosts` lines stay. `E2E_PROBE_AREAS` limits the sweep here too. A run takes about six minutes once the images are pulled.

The workflow `.github/workflows/e2e-mastodon.yml` installs the dependencies and calls this script, once for each mode: both servers open, tstodon in secure mode, both in secure mode. It runs:

- on a pull request that changes `packages/worker/server`, `packages/worker/app`, `packages/api`, `packages/domain`, `packages/core`, `e2e/mastodon`, `e2e/lib.ts` or the lockfile;
- every night, on `main`;
- by hand (`workflow_dispatch`), on any branch.

A failed leg uploads `.cache/e2e-mastodon/` as the artifact `e2e-mastodon-logs-<mode>`. The workflow reads no repository secret, because the scripts generate every key. It does not cache the Docker images: the runner pulls them about as fast as it would restore a cache.

### Secure mode

Each server has its own switch. Run the sweep in each combination:

```sh
MASTODON_AUTHORIZED_FETCH=true e2e/mastodon/bootstrap.sh       # Mastodon: restarts web and Sidekiq
TSTODON_AUTHORIZED_FETCH=true e2e/mastodon/start-tstodon.sh    # tstodon: AUTHORIZED_FETCH in .dev.vars
```

The sweep reads which mode each server is in from an unsigned fetch of an actor. The `authorized-fetch` area then checks that a server in secure mode refuses unsigned fetches, and skips that step for a server that is not.

### The Mastodon users

`bootstrap.sh` provisions five users. They outlive a sweep, so each has one job, and a scenario must not change that:

| User                             | Job                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `mona`                           | Follows the tstodon users of a run, and they follow her                                               |
| `carol`                          | No tstodon user keeps a follow of her: tstodon sees her posts only when it fetches them               |
| `dana`                           | The follow scenarios lock her and leave her tstodon followers; her notification policy is the default |
| `erin`                           | No tstodon user ever follows her                                                                      |
| `long_username_for_interop_0123` | The longest username Mastodon allows (30 characters); no tstodon user ever follows it                 |

To start over, remove both sides' state. Mastodon generates new actor keys, and tstodon would keep the old ones cached.

```sh
docker compose -f e2e/mastodon/compose.yaml down -v
rm -rf e2e/mastodon/.state e2e/mastodon/.dev.vars .wrangler/e2e-mastodon
```

## Scripts

| Script                | Command                   | Coverage                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `follow-both-ways.ts` | `pnpm e2e:mastodon`       | Alice on tstodon resolves and follows Mona on Mastodon, Mastodon accepts, Mona's post reaches Alice's home timeline. Mona resolves and follows Alice, Alice's post reaches Mona's home timeline.                                                                                                                                                             |
| `probe.ts`            | `pnpm e2e:mastodon:probe` | The sweep. Its `base` area sends each interaction in both directions: follow, public and followers-only posts, mentions, direct messages, URL search, replies, favourites, boosts, edits, polls and votes, media, hashtags, quote posts, custom emoji (Mastodon to tstodon only), profile updates, deletes, unfollow, block. A failed step does not stop it. |

The other areas of the sweep are one file each, and `sweep.ts` holds what they share:

| File                        | Area               | Coverage                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe-search.ts`           | `search`           | Search with `resolve=true`: a profile page URL and an actor URI (one fetch each, counted in Mastodon's log), a post's page URL (`/@user/id`), `@user@host` and `user@host`, `accounts/lookup`, `accounts/search`, a local account by its full acct, a long acct. |
| `probe-direct.ts`           | `direct`           | A direct message to three recipients on both servers, a reply chain of three in one conversation, and a stranger's direct message under the receiver's notification policy.                                                                                      |
| `probe-threads.ts`          | `threads`          | A reply whose parent the receiving server never saw, a thread five posts deep across both servers, and context backfill of ancestors and replies.                                                                                                                |
| `probe-follows.ts`          | `follows`          | A locked account on each side: a follow request authorized, one rejected, and a follow again after the reject. Remove a follower. A follow and an unfollow at once.                                                                                              |
| `probe-authorized-fetch.ts` | `authorized-fetch` | Signed fetches of an actor with its collection counts and of a note, each way. For a server in secure mode: unsigned fetches are refused.                                                                                                                        |

A step that fails for a tracked gap is a `knownGap` step. It is listed as `gap`, does not fail the sweep, and fails it once it passes, so the marker goes away with the fix.

Both scripts sign up a fresh tstodon user per run, so they rerun against the same state.

## Why each setting is there

<!-- derived-from #what-runs -->

### Names and TLS

Mastodon in production mode builds `https://` URLs for itself and fetches WebFinger over `https://`. tstodon also looks up WebFinger over `https://` for every host that is not a listed loopback address. So both servers need an HTTPS name.

- `bootstrap.sh` creates a CA and one leaf certificate for both names with `openssl`. Caddy serves that certificate (`auto_https off`, so it never asks an ACME server).
- Mastodon trusts the CA through `SSL_CERT_FILE=/certs/ca.crt`. Ruby's OpenSSL reads that variable, and Mastodon's HTTP client uses the default store.
- The Worker trusts the CA through `NODE_EXTRA_CA_CERTS`. Miniflare passes that file to workerd. Node takes one file there, so `bootstrap.sh` writes `.state/certs/node-extra-ca.pem` with the caller's existing extra CAs and the harness CA together.
- The proxy container has the network aliases `mastodon.test` and `tstodon.localhost`, so Mastodon resolves both names to the proxy. On the host, `/etc/hosts` maps both names to `127.0.0.1`, where the proxy is published.
- The proxy reaches the Worker at `172.30.47.1:8791`, the host's address on the Compose network's bridge, and `vp dev` listens on that address only. This Worker accepts the committed test Access key, so anyone who can reach its port can sign in: it must not listen on `0.0.0.0`. Run `bootstrap.sh` first, because the address exists once the network does.

The tstodon name has to end in `.localhost` (or `.local`). The scripts sign up through the test Access key (`packages/worker/test/access-jwt-fixture.ts`), and `isLocalAccessHost` (`packages/worker/server/access-jwt.ts`) accepts that key only on a local host name. With `tstodon.test`, `/auth/sign_in` answers 200 without a session and the consent post is a 403. Vite also allows `.localhost` hosts without configuration.

### Mastodon

- `ALLOWED_PRIVATE_ADDRESSES=172.30.47.0/24` is the Compose network. Without it Mastodon refuses to connect to the proxy's private address (`Mastodon::PrivateNetworkAddressError`).
- `SECRET_KEY_BASE` and the three `ACTIVE_RECORD_ENCRYPTION_*` keys are generated once into `.state/secrets.env`.
- `rails db:prepare` loads the schema and the seeds. It does nothing on a prepared database.
- `provision.rb` creates users the way `tootctl accounts create --confirmed --approve` does, and a Doorkeeper token for each, in one `rails runner` call. It also creates the custom emoji `:interop:`.
- `SMTP_DELIVERY_METHOD=test` keeps notification mails from failing in Sidekiq.

### tstodon

- `FEDERATION_ALLOW_HOSTS=tstodon.localhost,mastodon.test` (`tstodon.wrangler.jsonc`). A listed host skips the private-address refusal and the DNS check, which would ask a public resolver for `mastodon.test`.
- `BETTER_AUTH_SECRET` goes in the untracked `e2e/mastodon/.dev.vars`. The Worker reads bindings. A variable exported to the `vp dev` process did not reach it. `start-tstodon.sh` writes `AUTHORIZED_FETCH` there too, from `TSTODON_AUTHORIZED_FETCH`.
- `NO_PROXY` names both hosts. With `HTTPS_PROXY` set, the Worker's fetches and `curl` go to the proxy otherwise, and it cannot reach these names.

## What a Mastodon peer does differently from a tstodon peer

- A new account's actor URI is `https://mastodon.test/ap/users/<id>`, not `/users/<name>`. Take the URI from the account's `uri` field.
- Mastodon signs its fetches as the instance actor (`/actor`).
- Mastodon's default notification policy (`for_private_mentions: filter`) files a private mention from an account the receiver does not follow under a notification request. The status is stored, but there is no notification and no conversation until the receiver accepts the request (`NotifyService`, `UnfilterNotificationsWorker`). A reply in a thread where the receiver mentioned the sender is exempt.
- Mastodon leaves a boost out of a home feed that already holds the boosted post. To see a boost arrive, boost a post from an account the receiver does not follow.
- Mastodon leaves a reply out of a home feed unless the reader follows the account replied to. To see a reply arrive, mention the reader.
- A page URL (`https://mastodon.test/@carol`, `/@carol/<id>`) serves the actor or the note under another id (`/ap/users/<id>`, `/ap/users/<id>/statuses/<id>`). Mastodon's own lookup (`FetchResourceService`) fetches the URL, then the id it names, once.
- A note's `replies` collection embeds a first page with the author's own replies only. Every other account's replies are on the page its `next` links (`?only_other_accounts=true&page=true`).
- When Mastodon stores a note it fetches up to five replies of the same host from the note's embedded `replies` page (`FetchRepliesService`). It fetches the whole reply tree only for a note older than five minutes (`FETCH_REPLIES_INITIAL_WAIT_MINUTES`).
- The id of an `Undo(Follow)` is `<actor>#follows/<n>/undo`. `n` is the follow request's id while the follow is pending, and the follow's id once it is accepted. Those are two sequences, so two different `Undo`s of one actor can carry one id.
- Mastodon does not look up its own `/ap/users/<id>` actor URIs in search.
- Mastodon allows a user 1500 API requests per five minutes. A second sweep right after the first reaches that as mona. `sweep.ts` waits for the window and goes on.

## What the sweep found

<!-- constrained-by ../../docs/planning/open-todos.md#interop-with-real-mastodon-open -->

The sweep passes 84 of 84 steps with both servers open, 85 of 85 with tstodon in secure mode, and 86 of 86 with both in secure mode. Four more steps are known gaps.

Its first run (41 steps) found three tstodon bugs, each now fixed and covered by a Worker test:

1. `GET /api/v2/search` answered 500 (`LIKE or GLOB pattern too complex`) for any `q` longer than 48 bytes, which includes most post URLs, and did not look up a post URL (`server/search-url-resolve.test.ts`).
2. A remote status's `mentions` was always `[]` in the REST API (`server/remote-status-mentions.test.ts`).
3. A note URL the requester may not read answered `200 text/html` to Mastodon's `Accept` header. Mastodon expects 401, 403 or 404 and then falls back to its stored copy (`server/activitypub-negotiation.test.ts`).

The areas added for INT-1, INT-2, INT-3, INT-4 and INT-6 found five more, also fixed and covered:

4. A search for a page URL resolved to nothing, for a profile (`/@user`) and for a post (`/@user/id`), and an actor URI with no `type` was fetched twice (`server/search-url-resolve.test.ts`).
5. A search for `@user@tstodon.localhost` on tstodon answered a remote copy of the local account, which could not be followed (`server/search-url-resolve.test.ts`).
6. The reply backfill read only the first page of `replies`, so a Mastodon thread opened on tstodon showed the author's own replies and no one else's (`server/remote-thread-backfill.test.ts`).
7. A second `Undo(Follow)` with the id of an earlier one was dropped as a duplicate, and the unfollowed account stayed a follower (`server/inbox-claims.test.ts`).
8. The conversation of a Mastodon direct message left out the recipients on Mastodon (`server/remote-conversations.test.ts`).

The four known gaps (`gap` in the sweep's output):

- tstodon reports `for_private_mentions: drop` and notifies a Mastodon stranger's direct message all the same: the policy is not applied to a remote sender (INT-2).
- A tstodon note has no `replies` collection, so Mastodon cannot fetch the replies to a tstodon post it resolved (INT-4, two steps).
- tstodon fetches the direct replies of a remote post it opened, not the replies to those (INT-4).

The scenarios still to automate are the `INT-*` rows in [open TODOs](../../docs/planning/open-todos.md#interop-with-real-mastodon-open).

## Not covered yet

Account migration (`Move`), reports (`Flag`), custom emoji from tstodon to Mastodon, pinned posts, and the streaming API.
