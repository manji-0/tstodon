#!/usr/bin/env bash
# Brings up one real Mastodon behind a TLS proxy and provisions users on it.
# Idempotent: rerun it against a running or a stopped stack. See README.md.
#
#   ./bootstrap.sh [username ...]     (default users: mona carol)
#
# Writes .state/: the CA and leaf certificate, Mastodon's secrets, and
# `e2e.env` with the users' OAuth tokens for the scenario scripts.
set -euo pipefail

cd "$(dirname "$0")"
state=.state
certs=$state/certs
if [ $# -eq 0 ]; then set -- mona carol; fi
users=("$@")
started=$SECONDS

step() { printf '[%4ss] %s\n' "$((SECONDS - started))" "$*"; }

mkdir -p "$certs"
recreate=()

if [ ! -f "$certs/leaf.crt" ]; then
  step "generating the CA and the leaf certificate"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
    -subj "/CN=tstodon interop e2e CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
    -keyout "$certs/ca.key" -out "$certs/ca.crt" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -subj "/CN=mastodon.test" -keyout "$certs/leaf.key" -out "$certs/leaf.csr" 2>/dev/null
  printf 'subjectAltName=DNS:mastodon.test,DNS:tstodon.localhost\nextendedKeyUsage=serverAuth\n' \
    >"$certs/leaf.ext"
  openssl x509 -req -in "$certs/leaf.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" \
    -CAcreateserial -days 30 -extfile "$certs/leaf.ext" -out "$certs/leaf.crt" 2>/dev/null
  # Caddy runs as root in its container, Mastodon as uid 991.
  chmod 644 "$certs/leaf.key" "$certs/ca.crt" "$certs/leaf.crt"
  # Running containers still mount the old files.
  recreate=(--force-recreate)
fi

# Node replaces nothing with NODE_EXTRA_CA_CERTS, but takes one file: keep the
# caller's extra CAs (a corporate proxy's, say) beside the harness CA.
{
  if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ "$NODE_EXTRA_CA_CERTS" != "$PWD/$certs/node-extra-ca.pem" ]; then
    cat "$NODE_EXTRA_CA_CERTS"
  fi
  cat "$certs/ca.crt"
} >"$certs/node-extra-ca.pem.tmp"
mv "$certs/node-extra-ca.pem.tmp" "$certs/node-extra-ca.pem"

if [ ! -f "$state/secrets.env" ]; then
  step "generating Mastodon's secrets"
  {
    echo "SECRET_KEY_BASE=$(openssl rand -hex 64)"
    echo "ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 16)"
    echo "ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 16)"
    echo "ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 16)"
  } >"$state/secrets.env"
fi

for name in mastodon.test tstodon.localhost; do
  if ! grep -Eq "^127\.0\.0\.1[[:space:]].*\b$name\b" /etc/hosts; then
    step "adding $name to /etc/hosts"
    if [ -w /etc/hosts ]; then
      echo "127.0.0.1 $name" >>/etc/hosts
    else
      echo "127.0.0.1 $name" | sudo tee -a /etc/hosts >/dev/null
    fi
  fi
done

step "starting postgres and redis"
docker compose up -d --wait db redis

step "preparing the database"
docker compose run --rm -T web bundle exec rails db:prepare

step "starting web, sidekiq and the proxy"
docker compose up -d --wait ${recreate[@]+"${recreate[@]}"} web sidekiq proxy

step "waiting for https://mastodon.test"
for _ in $(seq 1 60); do
  if curl -fsS --noproxy '*' --cacert "$certs/ca.crt" https://mastodon.test/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --noproxy '*' --cacert "$certs/ca.crt" https://mastodon.test/health >/dev/null

step "provisioning ${users[*]}"
provisioned=$(docker compose exec -T web bin/rails runner /provision.rb "${users[@]}" | grep '^PROVISIONED ')

{
  echo "NODE_EXTRA_CA_CERTS=$PWD/$certs/node-extra-ca.pem"
  echo "NO_PROXY=mastodon.test,tstodon.localhost,localhost,127.0.0.1${NO_PROXY:+,$NO_PROXY}"
  echo "E2E_A_ORIGIN=https://tstodon.localhost"
  echo "E2E_A_DOMAIN=tstodon.localhost"
  echo "E2E_MASTODON_ORIGIN=https://mastodon.test"
  echo "E2E_MASTODON_DOMAIN=mastodon.test"
  while read -r _ username token; do
    echo "E2E_MASTODON_TOKEN_$(echo "$username" | tr '[:lower:]' '[:upper:]')=$token"
  done <<<"$provisioned"
} >"$state/e2e.env"

step "ready: Mastodon at https://mastodon.test, variables in $PWD/$state/e2e.env"
