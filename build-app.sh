#!/usr/bin/env bash
# Sprint Board derleyici.
#
#   ./build-app.sh            GELISTIRME: bundle'i /Applications'a kurar ve
#                             veri katmanini REPODAN okutur (appdir dosyasi).
#                             view.html / fetch.mjs / lib.mjs duzenleyince
#                             derleme GEREKMEZ, uygulamayi yeniden baslat yeter.
#
#   ./build-app.sh --release  DAGITIM: veri katmanini bundle'in ICINE kopyalar
#                             (indiren kisinin repoya ihtiyaci olmaz), Developer
#                             ID ile imzalar, notarize eder, staple'lar ve
#                             dist/SprintBoard.zip uretir.
#
# Bundle SIFIRDAN kuruluyor: eskiden yalnizca binary kopyalaniyordu ve bu,
# .app'i olmayan temiz bir makinede "No such file or directory" ile oluyordu.
set -euo pipefail
cd "$(dirname "$0")"

RELEASE=0
[ "${1:-}" = "--release" ] && RELEASE=1

NODE_VERSION="${NODE_VERSION:-v24.21.0}"          # gomulen Node (LTS)
# Varsayilan universal: her Mac'te acilsin. Node tek basina ~236 MB'a cikiyor;
# yalnizca Apple Silicon dagitacaksan  ARCHS=arm64 ./build-app.sh --release
# boyutu yariya indirir (Intel Mac'te ACILMAZ).
ARCHS="${ARCHS:-arm64 x64}"

# Surum git tag'inden. Sabit "1.0" yazdigi surece hangi zip'in hangi kod oldugu
# ayirt edilemiyordu ve uygulama guncelleme kontrolu yapamiyordu.
# `|| true` SART: pipefail acik ve tag yokken `git describe` 128 donuyor;
# pipe'in durumu da 128 oluyor ve set -e script'i sessizce olduruyordu.
VERSION=$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)
[ -n "$VERSION" ] || VERSION="0.0.0"
BUILD_NUM=$(git rev-list --count HEAD 2>/dev/null || echo 1)
CACHE="${TMPDIR:-/tmp}/sprint-board-build-cache"   # indirilenler burada, repoda degil

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mHATA:\033[0m %s\n' "$*" >&2; exit 1; }

# Sertifikayi EN BASTA cozuyoruz: eskiden once derleyip 120 MB node indirip
# EN SONDA "sertifika yok" diye oluyordu.
DEV_ID=$(security find-identity -v -p codesigning 2>/dev/null \
         | grep "Developer ID Application" | head -1 \
         | sed -E 's/.*"(.*)"/\1/') || true

if [ "$RELEASE" = "1" ]; then
  [ -n "${DEV_ID:-}" ] || fail "Developer ID Application sertifikasi yok — notarize edilemez.
  Xcode -> Settings -> Accounts -> Manage Certificates -> + -> Developer ID Application"
  APP="dist/Sprint Board.app"
  rm -rf dist && mkdir -p dist
else
  APP="/Applications/Sprint Board.app"
fi

# --- derle ------------------------------------------------------------------
if [ "$RELEASE" = "1" ]; then
  # Dagitim ikilisi UNIVERSAL: Intel Mac'te de acilsin diye iki mimaride
  # derleyip lipo ile birlestiriyoruz. swiftc tek cagrida iki hedef almiyor.
  say "→ swiftc ($ARCHS) — sürüm ${VERSION} (build ${BUILD_NUM})"
  mkdir -p "$CACHE"
  slices=""
  for a in $ARCHS; do
    case "$a" in
      arm64) t=arm64-apple-macos13.0  ;;
      x64)   t=x86_64-apple-macos13.0 ;;
      *) fail "bilinmeyen mimari: $a (arm64 / x64)" ;;
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

# --- calisan surumu kapat ---------------------------------------------------
# Bundle YOLUYLA kapatiyoruz. `osascript -e 'quit app "SprintBoard"'` sessizce
# basarisiz oluyordu (bundle adi "Sprint Board", executable "SprintBoard") ve
# `open -a` eski surecin uzerine gelip yeni binary hic calismiyordu.
if [ "$RELEASE" = "0" ]; then
  pkill -f "Sprint Board.app/Contents/MacOS/SprintBoard" 2>/dev/null || true
  for _ in $(seq 1 10); do
    pgrep -f "Sprint Board.app/Contents/MacOS/SprintBoard" >/dev/null || break
    sleep 0.5
  done
  pgrep -f "Sprint Board.app/Contents/MacOS/SprintBoard" >/dev/null \
    && fail "eski surec kapanmadi, guncelleme iptal"
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
  <!-- Dock ikonu yok: masaustu widget'i. Kapatma/yenileme menu cubugu ⚔ simgesinden. -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# Resmi Node ikilisini indirir, checksum'ini dogrular, yolunu stdout'a basar.
# Indirilen bir ikiliyi dogrulamadan bundle'a koymak kabul edilemez.
fetch_node() {
  local arch="$1"
  local tarball="node-${NODE_VERSION}-darwin-${arch}.tar.gz"
  local out="$CACHE/node-${NODE_VERSION}-${arch}"
  if [ -x "$out" ]; then printf '%s' "$out"; return 0; fi
  mkdir -p "$CACHE"
  curl -fsSL -o "$CACHE/$tarball" "https://nodejs.org/dist/${NODE_VERSION}/${tarball}" \
    || fail "node indirilemedi: $tarball"
  curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
    || fail "SHASUMS256.txt indirilemedi"
  ( cd "$CACHE" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null ) \
    || fail "checksum TUTMADI: $tarball"
  tar -xzf "$CACHE/$tarball" -C "$CACHE" "node-${NODE_VERSION}-darwin-${arch}/bin/node"
  mv "$CACHE/node-${NODE_VERSION}-darwin-${arch}/bin/node" "$out"
  rm -rf "$CACHE/node-${NODE_VERSION}-darwin-${arch}" "$CACHE/$tarball"
  printf '%s' "$out"
}

if [ "$RELEASE" = "1" ]; then
  # Veri katmani bundle'in ICINE: indiren kisi repoyu klonlamak zorunda kalmasin.
  cp fetch.mjs lib.mjs view.html setup.html config.example.json "$APP/Contents/Resources/"
  say "✓ veri katmani bundle'a gomuldu"

  # Node da bundle'in ICINE: makinede node KURULU OLMASA da acilsin.
  say "→ node ${NODE_VERSION} indiriliyor ($ARCHS, checksum dogrulanacak)"
  node_slices=""
  for a in $ARCHS; do
    node_slices="$node_slices $(fetch_node "$a")"
  done
  # shellcheck disable=SC2086
  lipo -create $node_slices -output "$APP/Contents/Resources/node"
  # Hata ayiklama sembolleri bize lazim degil: 236 MB -> 190 MB.
  # DIKKAT: strip, Node'un kendi Apple imzasini BOZAR ve macOS ikiliyi aninda
  # SIGKILL'liyor (exit 137, "code or signature have been modified"). Yani
  # strip'ten sonra YENIDEN IMZALAMAK sart — asagidaki codesign adimi bunu
  # yapiyor, o adim atlanirsa bundle calismaz.
  strip -x "$APP/Contents/Resources/node"
  chmod +x "$APP/Contents/Resources/node"
  say "✓ node gomuldu ($(lipo -archs "$APP/Contents/Resources/node"))"
else
  # Gelistirmede repodan okunsun ki view.html duzenleyince derleme gerekmesin.
  printf '%s' "$(pwd -P)" > "$APP/Contents/Resources/appdir"
fi

# --- imza -------------------------------------------------------------------
if [ -n "${DEV_ID:-}" ]; then
  say "→ imzalaniyor: $DEV_ID"
  # SIRA onemli: ic ikililer once. Gomulu node ayrica JIT hakki istiyor —
  # V8 hardened runtime altinda bu hak olmadan acilir acilmaz coker.
  if [ -f "$APP/Contents/Resources/node" ]; then
    codesign --force --timestamp --options runtime \
      --entitlements node.entitlements --sign "$DEV_ID" "$APP/Contents/Resources/node"
  fi
  # --options runtime (hardened runtime) notarization icin ZORUNLU.
  codesign --force --timestamp --options runtime --sign "$DEV_ID" "$APP"
else
  say "→ ad-hoc imza (gelistirme)"
  codesign --force --sign - "$APP"
fi

# --- notarize ---------------------------------------------------------------
if [ "$RELEASE" = "1" ]; then
  PROFILE="${NOTARY_PROFILE:-sprint-board}"
  say "→ notarize ediliyor (profil: $PROFILE) — birkac dakika surebilir"
  ( cd dist && ditto -c -k --keepParent "Sprint Board.app" notarize.zip )
  xcrun notarytool submit dist/notarize.zip --keychain-profile "$PROFILE" --wait \
    || fail "notarization basarisiz. Profil yoksa:
  xcrun notarytool store-credentials \"$PROFILE\" --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>"
  # staple: damgayi .app'in icine gomer, boylece kullanici CEVRIMDISIYKEN de acabilir.
  # Gomulu node imzadan sonra GERCEKTEN caliseyor mu — strip/imza sirasi
  # bozulursa bu kontrol yakalar, kullanici acilmayan bir app indirmez.
  "$APP/Contents/Resources/node" --version >/dev/null \
    || fail "gomulu node calismiyor (imza/strip sirasi bozulmus olabilir)"
  say "✓ gomulu node dogrulandi"

  xcrun stapler staple "$APP"
  rm -f dist/notarize.zip
  ( cd dist && ditto -c -k --keepParent "Sprint Board.app" SprintBoard.zip )
  say "✓ dist/SprintBoard.zip hazir — GitHub Releases'e bu yuklenir"
  spctl -a -vvv "$APP" 2>&1 | sed 's/^/  /'
else
  open -a "$APP"
  say "✓ guncellendi ve yeniden baslatildi"
fi
