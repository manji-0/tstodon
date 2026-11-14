#!/usr/bin/env bash
# Runs the tstodon Worker that pairs with the Mastodon from bootstrap.sh, in
# the foreground, as https://tstodon.localhost (the proxy forwards to port 8791).
# Run bootstrap.sh first: it writes the CA this process has to trust.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../.."

set -a
# shellcheck disable=SC1091
source "$here/.state/e2e.env"
set +a

persist=.wrangler/e2e-mastodon
pnpm exec wrangler d1 migrations apply tstodon-e2e-mastodon --local \
  --config e2e/mastodon/tstodon.wrangler.jsonc --persist-to "$persist"

# Void's dev fallback secret applies only on localhost and 127.0.0.1. The
# Worker reads bindings, not this process's environment, so the secret goes
# in the untracked `.dev.vars` beside the Worker config.
if [ ! -f "$here/.dev.vars" ]; then
  echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >"$here/.dev.vars"
fi
export CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=../../e2e/mastodon/tstodon.wrangler.jsonc
export VOID_INSPECTOR_PORT=false
export TSTODON_PERSIST_TO=$persist

# Listen only on the host's address on the Compose network's bridge, where the
# proxy forwards. This Worker trusts the committed test Access key, so it must
# not listen on an address the LAN reaches (never 0.0.0.0).
exec pnpm exec vp -C packages/worker dev --port 8791 --strictPort --host 172.30.47.1
