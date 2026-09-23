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

## Jira kimlik doğrulaması — neden Worker var

Hedef: kullanıcı hiçbir şey yazmasın, "Atlassian ile giriş yap"a bassın.

**Atlassian public client DESTEKLEMİYOR.** Kimlik sunucusu
`token_endpoint_auth_methods_supported` olarak yalnızca `client_secret_basic`
ve `client_secret_post` ilan ediyor — `none` yok. PKCE destekleniyor ama
secret'ın YERİNE değil YANINDA. Ölçüldü: secret'sız token isteği
`401 access_denied` döner. Takip: ECO-283, "Gathering Interest".

Secret dağıtılan .app'e konamaz — zip'in içindeki .mjs dosyaları düz metin ve
repo public. Bu yüzden `worker/` var: tek işi secret'ı ekleyip isteği
Atlassian'a iletmek. Durum tutmaz, loglamaz.

- Worker: `https://sprint-board-auth.mustafa-uysal.workers.dev`
  (`/token`, `/refresh`, `/health`)
- Client ID kodda/`wrangler.toml`'da durur — sır değil.
- **Client secret YALNIZCA Cloudflare'de** (`wrangler secret put`). Repoya ASLA.
- Deploy: `cd worker && npx wrangler deploy`

**Token ömrü:** access 1 saat (arka planda sessizce yenilenir, tarayıcı
açılmaz), refresh rotating ve 90 gün hareketsizlikte dolar — her yenileme
90 günü sıfırlar. Yani uygulama açıldığı sürece giriş kalıcı.
**Rotating token tuzağı:** yeni refresh token KULLANILMADAN ÖNCE kaydedilmeli;
sıra bozulursa zincir kopar ve kullanıcı yeniden giriş yapmak zorunda kalır.

**API token yolu neden yeterli değil:** Atlassian Aralık 2024'ten beri API
token'lara en fazla 1 yıl ömür veriyor, süresiz seçenek yok. Yani o yolda
her kullanıcı yılda bir token'ı elle yenilemek zorunda.

Uçtan uca doğrulandı (2026-09-23): Worker'dan token HTTP 200 · siteler
`accessible-resources`'tan geliyor · e-posta `/me`'den geliyor ·
`api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...` ile gerçek sprint
sorgusu HTTP 200 · yenileme tarayıcı açılmadan HTTP 200.

**Henüz YAPILMADI:** Swift tarafı (giriş ekranı düğmeleri, yerel callback
dinleyicisi, token saklama) ve `fetch.mjs`'in Jira katmanının Bearer +
cloudId adresine taşınması. Mevcut Basic-auth yolu çalışmaya devam ediyor.

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

- **SIGPIPE uygulamayı ÖLDÜRÜR.** Token'lar fetch.mjs'e stdin'den veriliyor;
  alt süreç bir hatayla erken çıkarsa borunun okuma ucu kapanır ve yazma
  işlemi süreci öldürür (ölçüldü: `exit 141` = 128+13). `signal(SIGPIPE, SIG_IGN)`
  açılışta çağrılıyor — kaldırma. Belirtisi sinsi: widget önce bir hata
  gösterir, sonra sessizce kaybolur.
- **Alt sürece gidecek veriyi `p.run()`'DAN ÖNCE hazırla.** OAuth modunda
  `tokenPayload()` ağ isteği yapabiliyor; sonra hazırlanırsa fetch.mjs bu arada
  boş boruyu okuyup token'sız devam ediyor.
- **`readFileSync(0)` boru için güvenilir değil** — boru henüz boşsa EAGAIN
  atıyor ve "veri yok" gibi görünüyor. stdin EOF'a kadar akış olarak okunmalı.
- **Sahte `HOME` ile test etme.** Config dosyaları için işe yarıyor ama macOS
  login keychain'ini `$HOME/Library/Keychains/` altında aradığı için
  "Keychain Not Found" diyaloğu çıkıyor. Keychain'e dokunan testler gerçek
  HOME ile yapılmalı (önce config'i yedekle).

- `view.html`/`setup.html` ES module import edemez (`file://` origin). Düz JS yaz.
- `set -o pipefail` açık: `$(git ... | sed ...)` tag yokken 128 dönüp script'i
  sessizce öldürür. Böyle yerlerde `|| true` kullan.
- Kurulum ekranı açıkken veri yenileme çalışmamalı (`onSetupScreen` bayrağı).
- Derleme sonrası **PID'i karşılaştır**; eski süreç ayaktaysa yeni binary hiç
  çalışmaz ve "düzelttim" dediğin şey çalışmıyor olur.
