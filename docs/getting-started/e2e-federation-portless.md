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

`request.url` inside the Worker is `http://a.tstodon.localhost/…` when the client used HTTPS. `@cloudflare/vite-plugin` builds that URL from the plain socket to Vite and does not apply `X-Forwarded-Proto` to it. The signing string has no scheme, so the signature still holds. Actor ids come from `INSTANCE_PUBLIC_ORIGIN`.

## Sign-up behind the proxy

<!-- constrained-by ../reference/configuration.md#authentication -->
<!-- derived-from #why-the-signature-matches -->

Every federation script signs up before it delivers anything. `signUpBrowser` (`e2e/lib.ts`) posts `/oauth/authorize` with `Origin` set to the https public origin. The dev server's `request.url` is still `http://…`, and `isSameOriginPost` (`packages/worker/src/browser-session.ts`) used to compare that `Origin` to `new URL(request.url).origin`. The post was a 403 (`Authorization must be confirmed on this site.`), so the run never reached a signed delivery.

The check now accepts the post when `Origin` equals the request origin after `X-Forwarded-Proto` is applied, and when `Origin` equals `INSTANCE_PUBLIC_ORIGIN`. `pageOrigin` uses that public origin for the web UI's streaming URL (`web-app.ts`) and for the OAuth metadata fallback (`oauth.ts`), which used to copy `request.url` as well. Keep the proxy on HTTPS. `--no-tls` makes WebFinger ask for `https://` names that nothing is serving.

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

Each `portless … vp dev` process stays in the foreground, so A and B are two terminals. A new terminal does not inherit the variables. In each terminal that starts an instance, source the example and set a secret after that (the example leaves `BETTER_AUTH_SECRET` empty, so sourcing it clears a secret you already exported):

```sh
set -a
source e2e/portless.env.example
set +a
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
```

Instance A. `--app-port` is the port `vp dev` binds.

```sh
portless --app-port 8791 a.tstodon -- \
  env CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=../../e2e/portless-a.wrangler.jsonc \
      VOID_INSPECTOR_PORT=false \
      TSTODON_PERSIST_TO=.wrangler/e2e-a \
      BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
      NO_PROXY="$NO_PROXY" \
  pnpm exec vp -C packages/worker dev --port 8791 --strictPort --host 127.0.0.1
```

Instance B, in the other terminal, after the same `source` and a new `BETTER_AUTH_SECRET`: `b.tstodon`, port `8792`, `e2e/portless-b.wrangler.jsonc`, and `.wrangler/e2e-b`.

In a third terminal, source the example again (the test process needs `NODE_EXTRA_CA_CERTS` and the `E2E_*` variables, not the auth secret). Wait until both instances answer, then run a script. The scripts read `E2E_*_ORIGIN` and `E2E_*_DOMAIN`. Deliveries are matched on `B_DOMAIN`, so the same variables cover every `pnpm e2e:federation:*` script. `openStream` turns `https://` into `wss://`, and portless proxies WebSockets.

```sh
set -a
source e2e/portless.env.example
set +a
curl --cacert "${HOME}/.portless/ca.pem" -fsS https://a.tstodon.localhost/.well-known/nodeinfo
curl --cacert "${HOME}/.portless/ca.pem" -fsS https://b.tstodon.localhost/.well-known/nodeinfo
pnpm e2e:federation:remote-follow
```

The loopback `process-compose` processes keep `e2e/a.wrangler.jsonc` and `e2e/b.wrangler.jsonc`. Do not run both pairs at once: they share ports 8791 and 8792 and the same persist dirs.
