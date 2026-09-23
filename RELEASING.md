# Sürüm çıkarma

Çıkan şey: `dist/SprintBoard.zip` (~70 MB). İndiren kişi `/Applications`'a atıp
çift tıklar; uyarı almaz, kurulum ekranı karşılar. Ne repo, ne node, ne terminal.

## Ön koşullar (bir kez)

- **Developer ID Application** sertifikası keychain'de
  (`security find-identity -v -p codesigning | grep "Developer ID"`)
- **notarytool profili** (`xcrun notarytool history --keychain-profile sprint-board`)

Yoksa `README.md`'deki "Dağıtım derlemesi" bölümü nasıl kurulacağını anlatıyor.
İkisi de Apple hesabı girişi gerektirir, otomatikleştirilemez.

## Adımlar

**1. Her şey temiz ve yeşil olmalı**

```bash
node --test test.mjs
git status --porcelain          # boş olmalı
```

**2. Sürümü tag ile belirle** — `Info.plist` buradan üretiliyor, ELLE YAZMA

```bash
git tag -a v1.1.0 -m "Ne değişti"
```

Tag'i ve dalı uzağa yolla (`--tags` ile). Bu repoda yayınlama `push-gate`
üzerinden geçiyor; ajan oturumundaysan o kapıyı atlamaya çalışma.

**3. Derle, imzala, notarize et, staple'la** — Apple'a YÜKLER, birkaç dakika sürer

```bash
./build-app.sh --release
```

**4. Gatekeeper'ı doğrula** — `accepted` ve `Notarized Developer ID` görmelisin

```bash
spctl -a -vvv "dist/Sprint Board.app"
```

**5. Release'i yayınla**

```bash
gh release create v1.1.0 dist/SprintBoard.zip --title "v1.1.0" --notes "Ne değişti"
```

## İndirilmiş gibi test etmek

Notarization'ın gerçekten işe yaradığını görmenin tek yolu quarantine damgasını
elle vurmak — yerelde derlenen `.app`'e o damga hiç takılmadığı için normal test
yanıltıcıdır:

```bash
rm -rf /tmp/dl && mkdir /tmp/dl && ditto -x -k dist/SprintBoard.zip /tmp/dl
xattr -w com.apple.quarantine "0083;00000000;Safari;" "/tmp/dl/Sprint Board.app"
spctl -a -vvv "/tmp/dl/Sprint Board.app"      # accepted olmalı
xcrun stapler validate "/tmp/dl/Sprint Board.app"
```

## Kullanıcılar nasıl haber alır

Widget her yenilemede (30 dk) `releases/latest`'e bakıyor; kendi sürümünden
yeniyse kartın altında **"⬆ vX.Y.Z çıktı — indirmek için tıkla"** satırı çıkıyor,
tıklayınca release sayfası açılıyor.

Bunun çalışması için:

- Release **taslak/ön sürüm OLMAMALI** (`releases/latest` onları atlar)
- Tag `vX.Y.Z` biçiminde olmalı
- Kullanıcının GitHub token'ı repoyu görebilmeli (private repo → collaborator)

Uygulama kendini güncelleyemez: imzalı bundle'ın içi değiştirilemez. Kullanıcı
yeni zip'i indirip `/Applications`'daki eskisinin üzerine atar.

## Sürüm numarası

`build-app.sh` `git describe --tags --abbrev=0` kullanıyor. Tag yoksa `0.0.0`
yazılır ve uygulama güncelleme kontrolünü HİÇ yapmaz — geliştirme derlemesinde
istenen davranış budur.
