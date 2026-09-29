#!/usr/bin/env bash
# Sprint Board installer — builds from source.
#
# WHY FROM SOURCE: macOS stamps every DOWNLOADED .app with a quarantine
# attribute and Gatekeeper rejects an ad-hoc signed app (spctl: rejected), so
# every user would have to click "Open Anyway" by hand in System Settings. A
# binary built LOCALLY never picks up quarantine — no dialog, and no Apple
# Developer account needed either.
#
# Usage:
#   ./install.sh              install / update
#   ./install.sh --no-build   only prepare prerequisites and settings
set -euo pipefail

REPO="${SPRINT_BOARD_REPO:-mustafauyysl/sprint-board}"
DIR="${SPRINT_BOARD_DIR:-$HOME/.local/share/sprint-board}"
CONFIG_DIR="$HOME/.config/sprint-widget"
CONFIG="$CONFIG_DIR/config.json"
BUILD=1
ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    *) printf 'unknown option: %s\n' "$a" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Prerequisites --------------------------------------------------------
# A GUI app does not see the shell PATH, so node/gh are resolved from CANDIDATE
# DIRECTORIES at runtime (see resolveExecutable). We look in the same places here
# so nothing passes at install time and then explodes at runtime.
have() {
  for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do
    [ -x "$d/$1" ] && return 0
  done
  return 1
}

# swiftc ships with the Xcode Command Line Tools; it cannot be installed via brew.
have swiftc || fail "swiftc is missing. Run this first:  xcode-select --install"

# node and gh are NOT stock, they come from Homebrew. Install them ourselves when
# possible — there is no point making someone on a fresh machine memorise commands.
ensure() {
  local tool="$1" formula="$2"
  have "$tool" && return 0
  have brew || fail "$tool is missing and so is Homebrew. Install Homebrew first:
    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
  then run this script again."
  if [ "$ASSUME_YES" = "0" ]; then
    printf '  %s is missing. Run "brew install %s"? [y/N] ' "$tool" "$formula"
    read -r reply </dev/tty || reply=""
    case "$reply" in [yY]*) ;; *) fail "$tool is required. Manually:  brew install $formula" ;; esac
  fi
  say "→ brew install $formula"
  brew install "$formula"
  have "$tool" || fail "$formula was installed but $tool still cannot be found"
}

ensure node node
ensure gh gh

# Cloning and the PR layer both need an authenticated gh session.
gh auth status >/dev/null 2>&1 || fail "no gh session. Run:  gh auth login"
say "✓ prerequisites satisfied"

# --- 2. Fetch the code -------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "→ updating the existing checkout: $DIR"
  git -C "$DIR" pull --ff-only
else
  say "→ cloning: $REPO -> $DIR"
  mkdir -p "$(dirname "$DIR")"
  # Clone via gh: a plain https clone prompts for credentials when the repo is
  # private, whereas gh reuses the already-authorised session.
  gh repo clone "$REPO" "$DIR"
fi

# --- 3. Settings -------------------------------------------------------------
# Only defaults (thresholds, sounds, statuses) are seeded here. Identity — Jira
# site, email, cloudId — is filled in by the app's own setup screen after you
# sign in with Atlassian, so there is nothing to edit by hand.
if [ -f "$CONFIG" ]; then
  say "✓ settings file already present: $CONFIG"
else
  mkdir -p "$CONFIG_DIR"
  cp "$DIR/config.example.json" "$CONFIG"
  say "→ settings file created: $CONFIG"
fi

# --- 4. Tests + build --------------------------------------------------------
say "→ tests"
( cd "$DIR" && node --test test.mjs >/dev/null ) && say "✓ tests passed"

if [ "$BUILD" = "1" ]; then
  say "→ building and installing into /Applications"
  ( cd "$DIR" && ./build-app.sh )
  say "✓ installed. Managed from the ⚔ icon in the menu bar (there is no Dock icon)."
  say "  On first launch the setup screen opens — click Sign in with Atlassian."
else
  say "(--no-build: build skipped)"
fi
