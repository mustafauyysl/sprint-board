#!/usr/bin/env bash
# Sprint Board builder.
#
#   ./build-app.sh            DEVELOPMENT: installs the bundle into /Applications
#                             and points the data layer at the REPO (an appdir
#                             file). Editing view.html / fetch.mjs / lib.mjs needs
#                             NO rebuild — just restart the app.
#
#   ./build-app.sh --release  DISTRIBUTION: copies the data layer INSIDE the
#                             bundle (so whoever downloads it never needs the
#                             repo), signs with Developer ID, notarises, staples
#                             and produces dist/SprintBoard.zip.
#
# The bundle is built FROM SCRATCH: it used to copy only the binary, which died
# with "No such file or directory" on a clean machine that had no .app yet.
set -euo pipefail
cd "$(dirname "$0")"

RELEASE=0
[ "${1:-}" = "--release" ] && RELEASE=1

NODE_VERSION="${NODE_VERSION:-v24.21.0}"          # the embedded Node (LTS)
# Universal by default so it opens on every Mac. Node alone reaches ~236 MB; if
# you only ship to Apple Silicon,  ARCHS=arm64 ./build-app.sh --release
# halves the size (that build will NOT open on an Intel Mac).
ARCHS="${ARCHS:-arm64 x64}"

# Version comes from the git tag. While it said a fixed "1.0" there was no way to
# tell which zip held which code, and the app could not check for updates.
# `|| true` is REQUIRED: with pipefail on and no tags, `git describe` returns 128;
# the pipeline inherits that status and set -e killed the script silently.
VERSION=$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)
[ -n "$VERSION" ] || VERSION="0.0.0"
BUILD_NUM=$(git rev-list --count HEAD 2>/dev/null || echo 1)
CACHE="${TMPDIR:-/tmp}/sprint-board-build-cache"   # downloads live here, not in the repo

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Resolve the certificate UP FRONT: this used to compile, download 120 MB of node
# and only THEN fail with "no certificate".
DEV_ID=$(security find-identity -v -p codesigning 2>/dev/null \
         | grep "Developer ID Application" | head -1 \
         | sed -E 's/.*"(.*)"/\1/') || true

if [ "$RELEASE" = "1" ]; then
  [ -n "${DEV_ID:-}" ] || fail "no Developer ID Application certificate — cannot notarise.
  Xcode -> Settings -> Accounts -> Manage Certificates -> + -> Developer ID Application"
  APP="dist/Sprint Board.app"
  rm -rf dist && mkdir -p dist
else
  APP="/Applications/Sprint Board.app"
fi

# --- compile ----------------------------------------------------------------
if [ "$RELEASE" = "1" ]; then
  # The distribution binary is UNIVERSAL so it opens on Intel Macs too: we build
  # for both architectures and join them with lipo. swiftc takes one target per call.
  say "→ swiftc ($ARCHS) — version ${VERSION} (build ${BUILD_NUM})"
  mkdir -p "$CACHE"
  slices=""
  for a in $ARCHS; do
    case "$a" in
      arm64) t=arm64-apple-macos13.0  ;;
      x64)   t=x86_64-apple-macos13.0 ;;
      *) fail "unknown architecture: $a (arm64 / x64)" ;;
    esac
    swiftc -O -target "$t" SprintBoard.swift -o "$CACHE/sb-$a"
    slices="$slices $CACHE/sb-$a"
  done
  # shellcheck disable=SC2086
  lipo -create $slices -output sprint-board
else
  say "→ swiftc"
  swiftc -O SprintBoard.swift -o sprint-board
fi

# --- stop the running copy --------------------------------------------------
# We kill it BY BUNDLE PATH. `osascript -e 'quit app "SprintBoard"'` failed
# silently (the bundle is named "Sprint Board", the executable "SprintBoard") and
# `open -a` then landed on top of the old process, so the new binary never ran.
if [ "$RELEASE" = "0" ]; then
  pkill -f "Sprint Board.app/Contents/MacOS/SprintBoard" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f "Sprint Board.app/Contents/MacOS/SprintBoard" >/dev/null || break
    sleep 0.5
  done
  pgrep -f "Sprint Board.app/Contents/MacOS/SprintBoard" >/dev/null \
    && fail "the old process did not exit, update aborted"
fi

# --- bundle -----------------------------------------------------------------
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp sprint-board "$APP/Contents/MacOS/SprintBoard"
cp SprintBoard.icns "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sprint Board</string>
  <key>CFBundleDisplayName</key><string>Sprint Board</string>
  <key>CFBundleIdentifier</key><string>com.mustafauysal.sprintboard</string>
  <key>CFBundleExecutable</key><string>SprintBoard</string>
  <key>CFBundleIconFile</key><string>SprintBoard</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD_NUM}</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- No Dock icon: this is a desktop widget. Quit/refresh live in the ⚔ menu bar item. -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# Downloads the official Node binary, verifies its checksum, prints its path.
# Putting a downloaded binary into the bundle unverified is not acceptable.
fetch_node() {
  local arch="$1"
  local tarball="node-${NODE_VERSION}-darwin-${arch}.tar.gz"
  local out="$CACHE/node-${NODE_VERSION}-${arch}"
  if [ -x "$out" ]; then printf '%s' "$out"; return 0; fi
  mkdir -p "$CACHE"
  curl -fsSL -o "$CACHE/$tarball" "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" \
    || fail "could not download node: $tarball"
  curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
    || fail "could not download SHASUMS256.txt"
  ( cd "$CACHE" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null ) \
    || fail "checksum MISMATCH: $tarball"
  tar -xzf "$CACHE/$tarball" -C "$CACHE" "node-${NODE_VERSION}-darwin-${arch}/bin/node"
  mv "$CACHE/node-${NODE_VERSION}-darwin-${arch}/bin/node" "$out"
  rm -rf "$CACHE/node-${NODE_VERSION}-darwin-${arch}" "$CACHE/$tarball"
  printf '%s' "$out"
}

if [ "$RELEASE" = "1" ]; then
  # Data layer INSIDE the bundle, so whoever downloads it never clones the repo.
  cp fetch.mjs lib.mjs view.html setup.html config.example.json "$APP/Contents/Resources/"
  say "✓ data layer embedded in the bundle"

  # Node INSIDE the bundle too, so it opens even with node NOT INSTALLED.
  say "→ downloading node ${NODE_VERSION} ($ARCHS, checksum will be verified)"
  node_slices=""
  for a in $ARCHS; do
    node_slices="$node_slices $(fetch_node "$a")"
  done
  # shellcheck disable=SC2086
  lipo -create $node_slices -output "$APP/Contents/Resources/node"
  # We do not need the debug symbols: 236 MB -> 190 MB.
  # CAREFUL: strip BREAKS Node's own Apple signature and macOS SIGKILLs the binary
  # immediately (exit 137, "code or signature have been modified"). So RE-SIGNING
  # after strip is mandatory — the codesign step below does it, and skipping that
  # step leaves a bundle that does not run.
  strip -x "$APP/Contents/Resources/node"
  chmod +x "$APP/Contents/Resources/node"
  say "✓ node embedded ($(lipo -archs "$APP/Contents/Resources/node"))"
else
  # In development read from the repo, so editing view.html needs no rebuild.
  printf '%s' "$(pwd -P)" > "$APP/Contents/Resources/appdir"
fi

# --- signing ----------------------------------------------------------------
if [ -n "${DEV_ID:-}" ]; then
  say "→ signing: $DEV_ID"
  # ORDER matters: inner binaries first. The embedded node additionally needs the
  # JIT entitlement — under the hardened runtime V8 crashes on start without it.
  if [ -f "$APP/Contents/Resources/node" ]; then
    codesign --force --timestamp --options runtime \
      --entitlements node.entitlements --sign "$DEV_ID" "$APP/Contents/Resources/node"
  fi
  # --options runtime (hardened runtime) is REQUIRED for notarisation.
  codesign --force --timestamp --options runtime --sign "$DEV_ID" "$APP"
else
  say "→ ad-hoc signature (development)"
  codesign --force --sign - "$APP"
fi

# --- notarise ---------------------------------------------------------------
if [ "$RELEASE" = "1" ]; then
  PROFILE="${NOTARY_PROFILE:-sprint-board}"
  say "→ notarising (profile: $PROFILE) — this can take a few minutes"
  ( cd dist && ditto -c -k --keepParent "Sprint Board.app" notarize.zip )
  xcrun notarytool submit dist/notarize.zip --keychain-profile "$PROFILE" --wait \
    || fail "notarisation failed. If the profile does not exist yet:
  xcrun notarytool store-credentials \"$PROFILE\" --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>"
  # Does the embedded node ACTUALLY run after signing — if the strip/sign order
  # ever breaks, this check catches it so nobody downloads an app that will not open.
  "$APP/Contents/Resources/node" --version >/dev/null \
    || fail "the embedded node does not run (the sign/strip order may be broken)"
  say "✓ embedded node verified"

  # staple: embeds the ticket inside the .app so it opens even OFFLINE.
  xcrun stapler staple "$APP"
  rm -f dist/notarize.zip
  ( cd dist && ditto -c -k --keepParent "Sprint Board.app" SprintBoard.zip )
  say "✓ dist/SprintBoard.zip ready — this is what goes to GitHub Releases"
  spctl -a -vvv "$APP" 2>&1 | sed 's/^/  /'
else
  open -a "$APP"
  say "✓ updated and restarted"
fi
