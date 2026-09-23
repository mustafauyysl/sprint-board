#!/usr/bin/env bash
# Sprint Board kurulumu — kaynaktan derler.
#
# NEDEN KAYNAKTAN: indirilen bir .app'e macOS quarantine damgası vurur ve
# Gatekeeper ad-hoc imzalı uygulamayı reddeder (spctl: rejected); her kullanıcı
# Sistem Ayarları'ndan elle "Yine de Aç" demek zorunda kalır. YERELDE derlenen
# binary'ye quarantine hiç takılmaz — diyalog da çıkmaz, Apple Developer
# hesabı da gerekmez.
#
# Kullanım:
#   ./install.sh              kur / güncelle
#   ./install.sh --no-build   sadece önkoşulları ve ayarları hazırla
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
    *) printf 'bilinmeyen seçenek: %s\n' "$a" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mHATA:\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Önkoşullar -----------------------------------------------------------
# GUI uygulaması shell PATH'ini görmediği için node/gh ADAY DİZİNLERDEN çözülüyor
# (bkz. resolveExecutable). Burada da aynı yerlere bakıyoruz ki kurulumda geçip
# çalışma anında patlayan bir durum olmasın.
have() {
  for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do
    [ -x "$d/$1" ] && return 0
  done
  return 1
}

# swiftc Xcode Command Line Tools'la gelir; brew ile kurulamaz.
have swiftc || fail "swiftc yok. Önce şunu çalıştır:  xcode-select --install"

# node ve gh stok DEĞİL, Homebrew'dan geliyor. Varsa kendimiz kuralım —
# yeni bir makinede kullanıcıyı komut ezberletmeye zorlamanın anlamı yok.
ensure() {
  local tool="$1" formula="$2"
  have "$tool" && return 0
  have brew || fail "$tool yok ve Homebrew da yok. Önce Homebrew kur:
    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
  sonra bu script'i tekrar çalıştır."
  if [ "$ASSUME_YES" = "0" ]; then
    printf '  %s yok. "brew install %s" çalıştırılsın mı? [e/H] ' "$tool" "$formula"
    read -r reply </dev/tty || reply=""
    case "$reply" in [eEyY]*) ;; *) fail "$tool gerekli. Elle:  brew install $formula" ;; esac
  fi
  say "→ brew install $formula"
  brew install "$formula"
  have "$tool" || fail "$formula kuruldu ama $tool hâlâ bulunamıyor"
}

ensure node node
ensure gh gh

# Klonlama ve PR katmanı yetkili gh oturumu istiyor.
gh auth status >/dev/null 2>&1 || fail "gh oturumu yok. Çalıştır:  gh auth login"
say "✓ önkoşullar tamam"

# --- 2. Kodu getir -----------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "→ mevcut kurulum güncelleniyor: $DIR"
  git -C "$DIR" pull --ff-only
else
  say "→ klonlanıyor: $REPO -> $DIR"
  mkdir -p "$(dirname "$DIR")"
  # gh ile klonluyoruz: repo private olduğunda düz https klonu kimlik soruyor,
  # gh zaten yetkilendirilmiş oturumu kullanıyor.
  gh repo clone "$REPO" "$DIR"
fi

# --- 3. Ayar dosyası ---------------------------------------------------------
if [ -f "$CONFIG" ]; then
  say "✓ ayar dosyası zaten var: $CONFIG"
else
  mkdir -p "$CONFIG_DIR"
  cp "$DIR/config.example.json" "$CONFIG"
  say "→ ayar dosyası oluşturuldu: $CONFIG"
  printf '  \033[33mAÇ VE DÜZENLE:\033[0m "email" alanına kendi e-postanı yaz.\n'
fi

# --- 4. Jira token -----------------------------------------------------------
# Token hiçbir dosyaya yazılmaz; keychain'de durur.
SERVICE=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.keychainService||"sprint-board-jira")' "$CONFIG")
EMAIL=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.email||"")' "$CONFIG")

if [ -n "$EMAIL" ] && security find-generic-password -s "$SERVICE" -a "$EMAIL" >/dev/null 2>&1; then
  say "✓ Jira token keychain'de mevcut"
else
  printf '\n  \033[33mJira token gerekiyor.\033[0m Token üret: https://id.atlassian.com/manage-profile/security/api-tokens\n'
  printf '  Sonra çalıştır:\n    security add-generic-password -s %s -a <e-postan> -w '"'"'<TOKEN>'"'"'\n\n' "$SERVICE"
fi

# --- 5. Testler + derleme ----------------------------------------------------
say "→ testler"
( cd "$DIR" && node --test test.mjs >/dev/null ) && say "✓ testler geçti"

if [ "$BUILD" = "1" ]; then
  say "→ derleniyor ve /Applications'a kuruluyor"
  ( cd "$DIR" && ./build-app.sh )
  say "✓ kuruldu. Menü çubuğundaki ⚔ simgesinden yönetiliyor (Dock ikonu yok)."
else
  say "(--no-build: derleme atlandı)"
fi
