#!/usr/bin/env bash
# One whole run of the interop harness, from nothing to nothing: the stack up,
# the Worker up, the gate and the sweep, the logs kept, everything down. CI
# runs this (.github/workflows/e2e-mastodon.yml), and so can you. See README.md.
#
#   e2e/mastodon/ci.sh
#   TSTODON_AUTHORIZED_FETCH=true MASTODON_AUTHORIZED_FETCH=true e2e/mastodon/ci.sh
#
# It removes a stack and a tstodon database left by an earlier run before it
# starts and again when it ends. E2E_MASTODON_KEEP=1 leaves them up at the end.
# Logs go to .cache/e2e-mastodon/ (E2E_MASTODON_LOGS names another directory).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cd "$root"
logs=${E2E_MASTODON_LOGS:-$root/.cache/e2e-mastodon}
started=$SECONDS
dev_pid=

step() { printf '[ci %4ss] %s\n' "$((SECONDS - started))" "$*"; }
group() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::group::$*"; else echo "--- $*"; fi; }
endgroup() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::endgroup::"; fi; }
compose() { docker compose -f "$here/compose.yaml" "$@"; }

# Mastodon makes new actor keys with a new database, and tstodon would keep the
# old ones cached: the two sides' state goes together. compose.yaml names
# .state/secrets.env, so without that file (a fresh checkout) Compose may not
# load the project, and bootstrap.sh never started a stack.
reset() {
  if [ -f "$here/.state/secrets.env" ]; then
    compose down -v --remove-orphans
  fi
  rm -rf "$root/.wrangler/e2e-mastodon"
}

finish() {
  status=$?
  trap - EXIT
  set +e
  if [ -n "$dev_pid" ]; then
    kill -TERM -- "-$dev_pid" 2>/dev/null
    wait "$dev_pid" 2>/dev/null
  fi
  compose ps -a >"$logs/compose-ps.txt" 2>&1
  for service in web sidekiq proxy db redis; do
    compose logs --no-color --timestamps "$service" >"$logs/compose-$service.log" 2>&1
  done
  if [ "$status" -ne 0 ]; then
    step "failed with status $status; the full logs are in $logs"
    group "compose ps"
    cat "$logs/compose-ps.txt"
    endgroup
    for log in tstodon-dev compose-web compose-sidekiq compose-proxy; do
      group "$log.log (last 150 lines)"
      tail -n 150 "$logs/$log.log" 2>&1
      endgroup
    done
  fi
  if [ -n "${E2E_MASTODON_KEEP:-}" ]; then
    step "E2E_MASTODON_KEEP is set: the Mastodon stack stays up"
  else
    step "tearing down"
    reset >"$logs/teardown.log" 2>&1 || cat "$logs/teardown.log"
  fi
  exit "$status"
}

rm -rf "$logs"
mkdir -p "$logs"
trap finish EXIT

step "removing what an earlier run left"
reset

step "bootstrap.sh (Mastodon authorized fetch: ${MASTODON_AUTHORIZED_FETCH:-false})"
"$here/bootstrap.sh"

step "start-tstodon.sh (tstodon authorized fetch: ${TSTODON_AUTHORIZED_FETCH:-false}), log in $logs/tstodon-dev.log"
# Its own session, so that `finish` can stop pnpm, vp and workerd together.
setsid "$here/start-tstodon.sh" >"$logs/tstodon-dev.log" 2>&1 &
dev_pid=$!

set -a
# shellcheck disable=SC1091
source "$here/.state/e2e.env"
set +a

step "waiting for https://tstodon.localhost (the first answer takes about 90 s)"
ready=
for _ in $(seq 1 100); do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    step "start-tstodon.sh exited before the Worker answered"
    exit 1
  fi
  if curl -fsS --noproxy '*' --max-time 120 --cacert "$here/.state/certs/ca.crt" \
    -o /dev/null https://tstodon.localhost/api/v1/instance 2>"$logs/tstodon-wait.log"; then
    ready=1
    break
  fi
  sleep 3
done
if [ -z "$ready" ]; then
  step "https://tstodon.localhost did not answer: $(cat "$logs/tstodon-wait.log")"
  exit 1
fi

# Both run, so that a failed gate still leaves the sweep's report.
failed=0
step "pnpm e2e:mastodon (the gate)"
pnpm e2e:mastodon 2>&1 | tee "$logs/gate.log" || failed=1
step "pnpm e2e:mastodon:probe (the sweep)"
pnpm e2e:mastodon:probe 2>&1 | tee "$logs/sweep.log" || failed=1

if [ "$failed" -ne 0 ]; then
  step "the gate or the sweep failed"
  exit 1
fi
step "the gate and the sweep passed"
