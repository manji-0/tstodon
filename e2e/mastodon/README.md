# Interop e2e against a real Mastodon

<!-- constrained-by ../../docs/getting-started/e2e-federation.md -->
<!-- constrained-by ../../docs/getting-started/e2e-federation-portless.md -->
<!-- constrained-by ../../docs/reference/configuration.md#limited-federation -->

Draft. This harness runs one real Mastodon (v4.7.5) next to a local tstodon Worker and federates them over HTTPS. The other federation suites pair tstodon with tstodon, so they cannot catch a disagreement with Mastodon itself. CI does not run this yet.

## What runs

| Piece                     | Where                                           | Name                        |
| ------------------------- | ----------------------------------------------- | --------------------------- |
| Mastodon web (Puma)       | container `web`, production mode                | `https://mastodon.test`     |
| Mastodon Sidekiq          | container `sidekiq`                             |                             |
| PostgreSQL 16, Redis 7    | containers `db` (tmpfs data), `redis`           |                             |
| TLS proxy (Caddy)         | container `proxy`, published on `127.0.0.1:443` | both names                  |
| tstodon Worker (`vp dev`) | the host, port 8791                             | `https://tstodon.localhost` |

Mastodon's streaming server is not started. The scripts use the REST API only.

## Prerequisites

- Docker with Compose v2, `openssl`, `curl`.
- `pnpm install` at the repository root.
- Port 443 free on the host, and write access to `/etc/hosts` (the script uses `sudo` when it has to).

## Run it

```sh
# 1. Mastodon, the proxy, the certificates, and the users mona and carol (about 25 s).
e2e/mastodon/bootstrap.sh

# 2. The tstodon Worker, in the foreground (about 90 s to the first answer).
e2e/mastodon/start-tstodon.sh

# 3. In another terminal: load the variables, then run a script.
set -a; source e2e/mastodon/.state/e2e.env; set +a
pnpm e2e:mastodon          # follow both ways, a post each way; the gate
pnpm e2e:mastodon:probe    # the sweep; reports every gap, exits 1 if any
```

`bootstrap.sh` is safe to rerun. A rerun gives each user a new token and rewrites `.state/e2e.env`. `MASTODON_AUTHORIZED_FETCH=true e2e/mastodon/bootstrap.sh` restarts Mastodon in secure mode. `MASTODON_VERSION` selects another image tag.

To start over, remove both sides' state. Mastodon generates new actor keys, and tstodon would keep the old ones cached.

```sh
docker compose -f e2e/mastodon/compose.yaml down -v
rm -rf e2e/mastodon/.state e2e/mastodon/.dev.vars .wrangler/e2e-mastodon
```

## Scripts

| Script                | Command                   | Coverage                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `follow-both-ways.ts` | `pnpm e2e:mastodon`       | Alice on tstodon resolves and follows Mona on Mastodon, Mastodon accepts, Mona's post reaches Alice's home timeline. Mona resolves and follows Alice, Alice's post reaches Mona's home timeline.                                                                                                                            |
| `probe.ts`            | `pnpm e2e:mastodon:probe` | Each interaction in both directions: follow, public and followers-only posts, mentions, direct messages, URL search, replies, favourites, boosts, edits, polls and votes, media, hashtags, quote posts, custom emoji (Mastodon to tstodon only), profile updates, deletes, unfollow, block. A failed step does not stop it. |

Both scripts sign up a fresh tstodon user per run, so they rerun against the same state.

## Why each setting is there

<!-- derived-from #what-runs -->

### Names and TLS

Mastodon in production mode builds `https://` URLs for itself and fetches WebFinger over `https://`. tstodon also looks up WebFinger over `https://` for every host that is not a listed loopback address. So both servers need an HTTPS name.

- `bootstrap.sh` creates a CA and one leaf certificate for both names with `openssl`. Caddy serves that certificate (`auto_https off`, so it never asks an ACME server).
- Mastodon trusts the CA through `SSL_CERT_FILE=/certs/ca.crt`. Ruby's OpenSSL reads that variable, and Mastodon's HTTP client uses the default store.
- The Worker trusts the CA through `NODE_EXTRA_CA_CERTS`. Miniflare passes that file to workerd. Node takes one file there, so `bootstrap.sh` writes `.state/certs/node-extra-ca.pem` with the caller's existing extra CAs and the harness CA together.
- The proxy container has the network aliases `mastodon.test` and `tstodon.localhost`, so Mastodon resolves both names to the proxy. On the host, `/etc/hosts` maps both names to `127.0.0.1`, where the proxy is published.
- The proxy reaches the Worker at `host.docker.internal:8791` (`host-gateway`). That is why `vp dev` listens on `0.0.0.0` here and not on `127.0.0.1`.

The tstodon name has to end in `.localhost` (or `.local`). The scripts sign up through the test Access key (`packages/worker/test/access-jwt-fixture.ts`), and `isLocalAccessHost` (`packages/worker/server/access-jwt.ts`) accepts that key only on a local host name. With `tstodon.test`, `/auth/sign_in` answers 200 without a session and the consent post is a 403. Vite also allows `.localhost` hosts without configuration.

### Mastodon

- `ALLOWED_PRIVATE_ADDRESSES=172.30.47.0/24` is the Compose network. Without it Mastodon refuses to connect to the proxy's private address (`Mastodon::PrivateNetworkAddressError`).
- `SECRET_KEY_BASE` and the three `ACTIVE_RECORD_ENCRYPTION_*` keys are generated once into `.state/secrets.env`.
- `rails db:prepare` loads the schema and the seeds. It does nothing on a prepared database.
- `provision.rb` creates users the way `tootctl accounts create --confirmed --approve` does, and a Doorkeeper token for each, in one `rails runner` call. It also creates the custom emoji `:interop:`.
- `SMTP_DELIVERY_METHOD=test` keeps notification mails from failing in Sidekiq.

### tstodon

- `FEDERATION_ALLOW_HOSTS=tstodon.localhost,mastodon.test` (`tstodon.wrangler.jsonc`). A listed host skips the private-address refusal and the DNS check, which would ask a public resolver for `mastodon.test`.
- `BETTER_AUTH_SECRET` goes in the untracked `e2e/mastodon/.dev.vars`. The Worker reads bindings. A variable exported to the `vp dev` process did not reach it.
- `NO_PROXY` names both hosts. With `HTTPS_PROXY` set, the Worker's fetches and `curl` go to the proxy otherwise, and it cannot reach these names.

## What a Mastodon peer does differently from a tstodon peer

- A new account's actor URI is `https://mastodon.test/ap/users/<id>`, not `/users/<name>`. Take the URI from the account's `uri` field.
- Mastodon signs its fetches as the instance actor (`/actor`).
- Mastodon's default notification policy filters a private mention from an account the receiver does not follow. The direct message arrives and has a conversation, but no notification.
- Mastodon leaves a boost out of a home feed that already holds the boosted post. To see a boost arrive, boost a post from an account the receiver does not follow.

## Known gaps the sweep reports

As of this draft the sweep passes 37 of 41 steps. The four failures are three tstodon bugs:

1. `GET /api/v2/search` answers 500 (`LIKE or GLOB pattern too complex`) for any `q` longer than 48 bytes, which includes most post URLs.
2. A remote status's `mentions` is always `[]` in the REST API.
3. A note URL the requester may not read answers `200 text/html` to Mastodon's `Accept` header. Mastodon expects 401, 403 or 404 and then falls back to its stored copy.

## Not covered yet

Account migration (`Move`), reports (`Flag`), locked accounts and follow requests, custom emoji from tstodon to Mastodon, pinned posts, the streaming API, and tstodon's own `AUTHORIZED_FETCH`.
