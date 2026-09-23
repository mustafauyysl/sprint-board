# Sprint Board — ajan notları

Masaüstü sprint widget'ı (macOS, Swift/AppKit + WKWebView + Node veri katmanı).
Kişisel araç, iş arkadaşlarına imzalı `.app` olarak dağıtılıyor.

**Bu dosyayı oku, sonra `README.md`'deki "Kanla öğrenilmiş notlar" bölümünü oku.**
Oradaki her madde canlı ölçümle bulunmuş bir tuzak; tahminle düzeltmeye çalışma.
Sürüm çıkarma yordamı ayrı: `RELEASING.md`.

## Oturumu repo kökünden başlat

```bash
cd ~/.local/share/sprint-board && claude
```

Repo kökü dışından açılan oturumda `.claude/settings.json` YÜKLENMEZ. O dosya
`code-review`, `security-reviewer` ve `test-coverage` plugin'lerini bu repo için
kapatıyor; yüklenmezse yayınlama adımı geçemeyeceğin kapılara takılır.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `node --test test.mjs` | Tüm testler. **Her değişiklikten sonra çalıştır, yeşil olmadan bitti deme.** |
| `node fetch.mjs --demo` | Jira'ya gitmeden sahte veriyle çıktı üretir |
| `node fetch.mjs` | Gerçek veri (~13 sn, 8 API çağrısı) |
| `./build-app.sh` | **Geliştirme** derlemesi → `/Applications`, veri katmanını REPODAN okur |
| `./build-app.sh --release` | **Dağıtım** derlemesi → `dist/`. Aşağıyı oku. |

`view.html` / `fetch.mjs` / `lib.mjs` geliştirme derlemesinde runtime'da okunur:
değiştirince **derleme gerekmez**, uygulamayı yeniden başlatmak yeter.
Swift değişirse `./build-app.sh`.

## Kırmızı çizgiler

- **`--release`'i keyfi çalıştırma.** `.app`'i **Apple'a yükler** (notarization).
  Sadece gerçekten sürüm çıkarılacaksa, `RELEASING.md`'yi izleyerek çalıştır.
- **İmzalanmış bundle'ın içini DEĞİŞTİRME.** Tek dosya bile imzayı bozar ve macOS
  uygulamayı `SIGKILL`'ler (ölçüldü: `exit 137`). Değişiklik = yeniden imzalama.
- **Gerçek veri koda girmez.** Gerçek Jira anahtarı, gerçek müşteri adı, gerçek
  kişi adı, gerçek GitHub login'i — demo fixture'ında da testlerde de YASAK.
  Uydurma kullan (`DEMO-101`, `Ada Yılmaz`, `demo-user`). Bir kez temizlendi,
  geri sokma.
- **Token'lar keychain'de.** Hiçbir dosyaya, hiçbir alt sürecin `argv`'sine yazma.
  Uygulama token'ları `fetch.mjs`'e **stdin** ile veriyor.
- **Sürüm elle yazılmaz.** `CFBundleShortVersionString` git tag'inden üretiliyor.
  Sürüm değiştirmek = yeni tag atmak.
- **`lib.mjs` saf kalmalı.** I/O yok, `Date.now()` yok — `now` hep parametre.
  Yeni mantık buraya + testi `test.mjs`'e. I/O `fetch.mjs`'te.

## Mimari

| Dosya | Rol |
|---|---|
| `SprintBoard.swift` | NSWindow + WKWebView, menü çubuğu, keychain, JS köprüsü |
| `view.html` | Pano ekranı (düz JS, framework yok, ES module DEĞİL) |
| `setup.html` | İlk açılış kurulum ekranı |
| `fetch.mjs` | I/O: Jira REST + GitHub GraphQL + keychain + ses |
| `lib.mjs` | Saf mantık, sıfır I/O |
| `test.mjs` | `node --test`, sıfır bağımlılık |

Config `~/.config/sprint-widget/config.json`, state `~/.local/state/sprint-widget/`.
İkisi de repo klasörünün DIŞINDA; oraya yazma.

## Sık yapılan hatalar

- `view.html`/`setup.html` ES module import edemez (`file://` origin). Düz JS yaz.
- `set -o pipefail` açık: `$(git ... | sed ...)` tag yokken 128 dönüp script'i
  sessizce öldürür. Böyle yerlerde `|| true` kullan.
- Kurulum ekranı açıkken veri yenileme çalışmamalı (`onSetupScreen` bayrağı).
- Derleme sonrası **PID'i karşılaştır**; eski süreç ayaktaysa yeni binary hiç
  çalışmaz ve "düzelttim" dediğin şey çalışmıyor olur.
