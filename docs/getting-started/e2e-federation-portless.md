# Federation e2e over portless

<!-- constrained-by ./e2e-federation.md -->
<!-- constrained-by ../reference/configuration.md#limited-federation -->
<!-- constrained-by ../reference/configuration.md#authentication -->

## Goal

Run the two local Workers from [Federation e2e](./e2e-federation.md) on public HTTPS names, `https://a.tstodon.localhost` and `https://b.tstodon.localhost`, and let them sign and verify each other’s ActivityPub requests through those names. The loopback pair (`http://127.0.0.1:8791` and `:8792`) already does real signatures over plain HTTP. This page is the HTTPS WebFinger path that pair never takes: WebFinger uses `http://` only for an allow-listed `localhost`, `127.0.0.1`, or `::1`.

[portless](https://portless.sh/) is a local HTTPS reverse proxy on `127.0.0.1:443` and `[::1]:443`. One hostname maps to one app port. It forwards the path and body unchanged, keeps `Digest`, `Date`, and `Signature`, and sets `Host` to the public name (HTTP/2 `:authority` is copied back to `Host`). Keep its default HTTPS listener. `--no-tls` serves plain HTTP, and WebFinger for these names still requests `https://`.

## Why the signature matches

<!-- derived-from #goal -->

tstodon signs `(request-target) host date digest` (`packages/worker/src/http-signature.ts`). Verification rebuilds that string from the path on `request.url`, the `Host` header, `Date`, and a SHA-256 of the body.

| Piece              | Through portless                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `(request-target)` | Path only. The proxy does not rewrite it.                                                                                            |
| `host`             | `url.host` of `https://b.tstodon.localhost/…` is `b.tstodon.localhost` (no port on 443). The proxy leaves that `Host` in place.      |
| `digest`           | Body bytes are forwarded as-is.                                                                                                      |
| `keyId`            | `${INSTANCE_PUBLIC_ORIGIN}/users/<name>#main-key`, so `https://a.tstodon.localhost/users/alice#main-key`. The peer fetches that URL. |

`request.url` inside the Worker is `http://a.tstodon.localhost/…` when the client used HTTPS. `@cloudflare/vite-plugin` builds the URL from the plain socket to Vite and ignores `X-Forwarded-Proto`. The signing string has no scheme, and actor ids come from `INSTANCE_PUBLIC_ORIGIN`, so verification still holds. Passkey sign-up can disagree: the client data and `Origin` are `https://`, while `request.url` is `http://`. If that check rejects the ceremony, the signed delivery is still the thing under test. Do not switch the proxy to HTTP to change the origin.

## What has to be set

<!-- constrained-by ../reference/configuration.md#limited-federation -->

`a.tstodon.localhost` ends in `.localhost`, so `isBlockedFederatedHost` refuses it until `FEDERATION_ALLOW_HOSTS` names that host. A non-empty list is limited federation, so each instance lists both names. The values are already in `e2e/portless-a.wrangler.jsonc` and `e2e/portless-b.wrangler.jsonc`. Those files keep the D1, KV, and R2 ids of `e2e/a.wrangler.jsonc` and `e2e/b.wrangler.jsonc`, and the dev processes use the same persist dirs, so `e2e/lib.ts` still reads the databases.

`*.localhost` resolves to loopback. Wrangler dev allows that connection, which is how the loopback suite already fetches `127.0.0.1`. The fetch then hits the proxy and is routed by `Host`. Start each `vp dev` under portless so the child receives `NODE_EXTRA_CA_CERTS` (the CA is `~/.portless/ca.pem`) before Miniflare passes it to workerd. The e2e process is not that child. Node’s fetch uses its own CA bundle, so the test command sets `NODE_EXTRA_CA_CERTS` too. `portless trust` updates the OS store and does not by itself make Node trust the CA.

`BETTER_AUTH_SECRET` is required. Void’s dev fallback applies only on `localhost` and `127.0.0.1` ([Authentication](../reference/configuration.md#authentication)). Generate a local value and export it. Do not commit it, and do not put it in the wrangler files.

If `HTTPS_PROXY` is set, outbound Worker fetches follow it and never reach loopback. `NO_PROXY` has to include the portless names.

## Commands

<!-- constrained-by ./e2e-federation.md#commands -->

Apply migrations once, the same persist dirs as the loopback suite:

```sh
pnpm exec wrangler d1 migrations apply tstodon-e2e-a --local --config e2e/portless-a.wrangler.jsonc --persist-to .wrangler/e2e-a
pnpm exec wrangler d1 migrations apply tstodon-e2e-b --local --config e2e/portless-b.wrangler.jsonc --persist-to .wrangler/e2e-b
```

Start the proxy (HTTPS on 443; a failed bind exits):

```sh
portless proxy start
```

Export the run’s environment from the example, then set a secret locally:

```sh
set -a
source e2e/portless.env.example
set +a
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
```

Instance A. `--app-port` is the port `vp dev` binds. Instance B is the same command with `b.tstodon`, port `8792`, `e2e/portless-b.wrangler.jsonc`, and `.wrangler/e2e-b`.

```sh
portless --app-port 8791 a.tstodon -- \
  env CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=../../e2e/portless-a.wrangler.jsonc \
      VOID_INSPECTOR_PORT=false \
      TSTODON_PERSIST_TO=.wrangler/e2e-a \
      BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
      NO_PROXY="$NO_PROXY" \
  pnpm exec vp -C packages/worker dev --port 8791 --strictPort --host 127.0.0.1
```

`e2e/lib.ts` reads `E2E_*_ORIGIN` and `E2E_*_DOMAIN`. `openStream` turns `https://` into `wss://`, and portless proxies WebSockets.

```sh
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS}" \
E2E_A_ORIGIN="${E2E_A_ORIGIN}" \
E2E_B_ORIGIN="${E2E_B_ORIGIN}" \
E2E_A_DOMAIN="${E2E_A_DOMAIN}" \
E2E_B_DOMAIN="${E2E_B_DOMAIN}" \
pnpm e2e:federation:remote-follow
```

Any other `pnpm e2e:federation:*` script uses the same variables. The loopback `process-compose` processes keep `e2e/a.wrangler.jsonc` and `e2e/b.wrangler.jsonc`. Do not run both pairs at once: they share ports 8791 and 8792 and the same persist dirs.
