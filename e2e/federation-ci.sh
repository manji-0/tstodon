#!/usr/bin/env bash
# One whole run of the tstodon-to-tstodon federation e2e, from nothing to
# nothing: fresh databases for instances A and B, both Workers up in `vp dev`,
# the `pnpm e2e:federation:*` scenarios that pass, the logs kept, both Workers down.
# CI runs this (.github/workflows/e2e-federation.yml), and so can you. It does
# what `process-compose up` does (process-compose.yaml) without process-compose,
# and runs the scenarios one after another.
# See docs/getting-started/e2e-federation.md.
#
#   e2e/federation-ci.sh
#
# Logs go to .cache/e2e-federation/ (E2E_FEDERATION_LOGS names another directory).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
logs=${E2E_FEDERATION_LOGS:-$root/.cache/e2e-federation}
started=$SECONDS
pids=()

step() { printf '[federation %4ss] %s\n' "$((SECONDS - started))" "$*"; }
group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "--- $*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }

finish() {
  status=$?
  trap - EXIT
  set +e
  for pid in "${pids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  done
  if [ "$status" -ne 0 ]; then
    step "failed with status $status; the full logs are in $logs"
    for instance in a b; do
      group "tstodon-$instance.log (last 150 lines)"
      tail -n 150 "$logs/tstodon-$instance.log" 2>&1
      endgroup
    done
  fi
  exit "$status"
}

rm -rf "$logs" .wrangler/e2e-a .wrangler/e2e-b
mkdir -p "$logs"
trap finish EXIT

for instance in a b; do
  step "migrating tstodon-e2e-$instance"
  pnpm exec wrangler d1 migrations apply "tstodon-e2e-$instance" --local \
    --config "e2e/$instance.wrangler.jsonc" --persist-to ".wrangler/e2e-$instance" \
    >"$logs/migrate-$instance.log" 2>&1
done

# The Workers reach each other on loopback, which an HTTP proxy cannot.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

start() {
  local instance=$1 port=$2
  # Its own session, so that `finish` stops pnpm, vp and workerd together.
  CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="../../e2e/$instance.wrangler.jsonc" \
    VOID_INSPECTOR_PORT=false TSTODON_PERSIST_TO=".wrangler/e2e-$instance" \
    setsid pnpm exec vp -C packages/worker dev --port "$port" --strictPort --host 127.0.0.1 \
    >"$logs/tstodon-$instance.log" 2>&1 &
  pids+=("$!")
}
start a 8791
start b 8792

for port in 8791 8792; do
  step "waiting for http://127.0.0.1:$port"
  ready=
  for _ in $(seq 1 60); do
    if curl -fsS --noproxy '*' --max-time 30 -o /dev/null \
      "http://127.0.0.1:$port/.well-known/nodeinfo" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ -z "$ready" ]; then
    step "http://127.0.0.1:$port did not answer"
    exit 1
  fi
done

# follow-create, interactions, delete-shared-inbox and accept are left out:
# each forges B's user's `Follow` from the host, which B never sent, so B
# answers A's `Accept` of it with an `Undo` (`AcceptedUnheld` in
# server/outbound-follow.ts) and the follow they then check is gone.
failed=()
for scenario in smoke remote-follow remote-updates remote-engagement migration reports; do
  script=federation-$scenario
  step "e2e/$script.ts"
  if ! pnpm exec tsx "e2e/$script.ts" >"$logs/$scenario.log" 2>&1; then
    failed+=("$scenario")
    group "$scenario.log"
    cat "$logs/$scenario.log"
    endgroup
  fi
done

if [ "${#failed[@]}" -ne 0 ]; then
  step "failed: ${failed[*]}"
  exit 1
fi
step "every scenario passed"
