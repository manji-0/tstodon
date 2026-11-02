#!/usr/bin/env bash
# Setup script for Claude Code cloud sessions (claude.ai/code).
#
# Paste this file's contents into the cloud environment's "Setup script"
# (session title bar -> environment menu -> Edit). It runs as root before the
# session starts, and is idempotent so re-runs are cheap.
#
# It installs:
#   1. Nix with flakes enabled (NixOS/nix-installer, no init system).
#   2. pstack (https://github.com/michael-denyer/pstack-claude) as a
#      user-scope Claude Code plugin.
#   3. kamae-ts (https://github.com/iwasa-kosui/kamae-ts) skills `kamae` and
#      `kamae-review` as user skills. Its plugin manifest currently fails to
#      load ("conflicting manifests"), so the skills are copied directly.
set -euo pipefail

log() { printf '[cloud-setup] %s\n' "$*"; }

# Outbound HTTPS goes through the session proxy; trust its CA when present.
if [ -f /root/.ccr/ca-bundle.crt ]; then
  export NIX_SSL_CERT_FILE="${NIX_SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt}"
  export GIT_SSL_CAINFO="${GIT_SSL_CAINFO:-/root/.ccr/ca-bundle.crt}"
fi

# --- 1. Nix (flakes) --------------------------------------------------------
NIX_PROFILE_SCRIPT=/nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

if [ -x /nix/var/nix/profiles/default/bin/nix ]; then
  log "Nix already installed"
else
  log "Installing Nix"
  # Containers have no systemd, so install without an init system.
  curl -sSfL https://artifacts.nixos.org/nix-installer \
    | sh -s -- install linux --init none --no-confirm
fi

# shellcheck disable=SC1090
[ -e "$NIX_PROFILE_SCRIPT" ] && . "$NIX_PROFILE_SCRIPT"

# The installer enables flakes already; make sure it stays that way.
if ! grep -qs 'flakes' /etc/nix/nix.conf /etc/nix/nix.custom.conf; then
  echo 'extra-experimental-features = nix-command flakes' >> /etc/nix/nix.custom.conf
fi

# Make nix available to non-login shells used by the session.
ln -sf /nix/var/nix/profiles/default/bin/nix /usr/local/bin/nix
nix --version

# --- 2. pstack (Claude Code plugin) ----------------------------------------
if ! command -v claude > /dev/null 2>&1; then
  log "claude CLI not found; skipping plugin and skill installation"
  exit 0
fi

if claude plugin marketplace list 2>/dev/null | grep -q 'pstack-claude'; then
  log "Updating pstack-claude marketplace"
  claude plugin marketplace update pstack-claude || true
else
  log "Adding pstack-claude marketplace"
  claude plugin marketplace add michael-denyer/pstack-claude
fi

log "Installing pstack plugin"
claude plugin install pstack@pstack-claude --scope user

# --- 3. kamae-ts (user skills) ---------------------------------------------
CLAUDE_HOME="${HOME}/.claude"
KAMAE_SRC="$(mktemp -d)"
trap 'rm -rf "$KAMAE_SRC"' EXIT

log "Fetching kamae-ts"
git clone --quiet --depth 1 https://github.com/iwasa-kosui/kamae-ts "$KAMAE_SRC"

# The plugin's `rules/defaults` are deliberately not copied: from
# ~/.claude/skills they would resolve to ~/.claude/rules, which Claude Code
# loads into every session. The skills run fine without them (they only
# auto-detect the Result / validation library from package.json).
mkdir -p "$CLAUDE_HOME/skills"
for skill in kamae kamae-review; do
  rm -rf "${CLAUDE_HOME:?}/skills/$skill"
  cp -R "$KAMAE_SRC/skills/$skill" "$CLAUDE_HOME/skills/$skill"
done

log "Done"
