# Sprint Board

Masaüstünde duran retro-RPG temalı sprint takip widget'ı (macOS). Açık sprintteki
kendi Jira taskların, her birinin **statüde geçirdiği iş günü**, eşiği aşanın BOSS
olarak yanıp sönmesi ve PR/CI durumu.

Kişisel bir araç — kuruma ait değil, dağıtılmak için tasarlanmadı.

## Neden var

"Hangi task hangi statüde" bilgisi Jira'da zaten var. Kaybolan şey **bir işin bir
statüde ne kadar süredir çakılı kaldığı** — bu veri board görünümünde yok, yalnızca
changelog'dan çıkarılabiliyor.

## Mimari

| Dosya | Rol |
|---|---|
| `SprintBoard.swift` | NSWindow + WKWebView, menü çubuğu, sürükleme, JS köprüsü |
| `view.html` | Görsel katman (düz JS, framework yok) |
| `setup.html` | İlk açılış kurulum ekranı |
| `fetch.mjs` | I/O: Jira REST + GitHub GraphQL + keychain + ses |
| `lib.mjs` | Saf mantık — I/O yok, `Date.now()` yok (`now` parametre geçilir) |
| `test.mjs` | `node --test`, sıfır bağımlılık |
| `build-app.sh` | Derle → `/Applications/Sprint Board.app` → yeniden başlat |

Kod klasörünün **dışında** duranlar (bilerek):

- `~/.config/sprint-widget/config.json` — ayarlar (`config.example.json`'a bak)
- `~/.local/state/sprint-widget/` — `state.json` (ses tekrarını önleyen son
  görülen boss/kırık CI/review kaydı) + `notes.json`
- Jira token — **keychain**, servis `sprint-board-jira` (config'den değiştirilebilir)
- GitHub token — **keychain**, servis `sprint-board-github`. Yoksa `gh auth token`
  yedeğine düşülür, yani `gh` kuruluysa ekstra bir şey yapmaya gerek yok.

Hiçbir token dosyada düz metin durmuyor.

**İlk açılış:** config yoksa ya da Jira token'ı keychain'de yoksa uygulama
`view.html` yerine `setup.html` açıyor; Jira adresi, e-posta ve token'lar oradan
alınıp config yazılıyor, token'lar keychain'e konuyor. Sonradan menü çubuğundaki
**⚔ → Ayarlar…** ile tekrar açılabiliyor.

## Kurulum

```bash
gh repo clone mustafauyysl/sprint-board ~/.local/share/sprint-board
~/.local/share/sprint-board/install.sh
```

`install.sh` önkoşulları doğrular, kodu çeker, ayar dosyasını oluşturur,
testleri koşar, derler ve `/Applications/Sprint Board.app` olarak kurar.
Güncellemek için aynı komutu tekrar çalıştır (`git pull --ff-only` + yeniden derleme).

Gereken: **Xcode Command Line Tools** (`xcode-select --install`), **node**, **gh**
(`gh auth login` yapılmış olmalı). Ayrıca bir Atlassian API token'ı — script
nereye yazacağını söylüyor; token hiçbir dosyaya değil, keychain'e gidiyor.

### Dağıtım derlemesi

```bash
./build-app.sh --release
```

Veri katmanını (`fetch.mjs`, `lib.mjs`, `view.html`) bundle'ın **içine** kopyalar —
indiren kişinin repoyu klonlamasına gerek kalmaz —, Developer ID ile imzalar,
notarize eder, staple'lar ve `dist/SprintBoard.zip` üretir.

Çıkan `.app` **kendi kendine yeter**: veri katmanı da, Node de (v24.21.0, resmi
dağıtımdan indirilip checksum'ı doğrulanarak) içinde. İndiren kişinin ne repo, ne
node, ne Homebrew kurması gerekiyor.

Binary ve Node universal (arm64 + x86_64) → her Mac'te açılır. Bundle ~191 MB,
indirilen zip ~80 MB (karşılaştırma: Slack 551 MB, VS Code 1.4 GB — bu sınıf için
küçük sayılır). Yalnızca Apple Silicon'a dağıtacaksan
`ARCHS=arm64 ./build-app.sh --release` boyutu yarıya indirir; o derleme
**Intel Mac'te açılmaz**.

Node `strip -x` ile küçültülüyor (236 → 190 MB). Bu, Node'un kendi Apple
imzasını bozduğu için hemen ardından yeniden imzalanması **şart** — yoksa macOS
ikiliyi açılır açılmaz SIGKILL'liyor. `--release` bunu yapıyor ve gömülü node'u
imzadan sonra bir kez çalıştırıp doğruluyor.

Gerekenler: **Developer ID Application** sertifikası (ücretli Apple Developer
Program üyeliği) ve bir notarytool profili:

```bash
xcrun notarytool store-credentials "sprint-board" \
  --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>
```

### Neden ad-hoc imzayla hazır `.app` dağıtmıyoruz

macOS, **indirilen** her dosyaya `com.apple.quarantine` damgası vurur ve
Gatekeeper ad-hoc imzalı bir uygulamayı reddeder (`spctl -a` → `rejected`).
Hazır binary dağıtsaydık her kullanıcı Sistem Ayarları'ndan elle "Yine de Aç"
demek zorunda kalırdı — ya da Apple Developer Program üyeliğiyle notarization
gerekirdi. **Yerelde derlenen** binary'ye quarantine hiç takılmadığı için
kaynaktan kurulum bu iki maliyeti de sıfırlıyor.

## Kullanım

- Menü çubuğundaki **⚔** → yenile / öne getir / çık (Dock ikonu yok, `LSUIElement`)
- Kartın **üst şeridinden** sürükle; aynı şeritteki **⟳** yeniler
- Yenileme 30 dakikada bir, ~13 sn sürer

`view.html` / `fetch.mjs` / `lib.mjs` runtime'da okunuyor → değiştirince **derleme
gerekmez**, uygulamayı yeniden başlatmak yeter. Swift değişirse `./build-app.sh`.

## Kanla öğrenilmiş notlar

- **`statuscategorychangedate` kullanılamaz.** Kategori içi geçişlerde (In Progress →
  In Code Review, ikisi de `indeterminate`) resetlenmiyor. Süreler changelog'dan.
- **`statusCheckRollup.state` kullanılamaz** — opsiyonel check'leri de sayar ve
  "CI kırık" yanlış alarmı üretir. Check başına `isRequired(pullRequestNumber:)`.
- **Yeniden çalıştırılan check duplikasyonu:** GitHub aynı check'in hem eski hem yeni
  run'ını tutar (CANCELLED + SUCCESS). Sadece en son run sayılmalı.
- **Done kategorisi ≠ bitmiş.** Bu Jira'da done kategorisinde 15 statü var. Ayrım
  bir **izin listesi** ile yapılıyor (`pendingReleaseStatuses`): listede olan
  "canlıya çıkmayı bekliyor", DİĞER HEPSİ bitmiş sayılır. Tersi denendi ve
  yanlıştı — "bitmişler" listesi tanınmayan her statüyü sonsuza dek "bekliyor"
  gösteriyordu (Closed, Resolved, Problem Solved, Epic is Done, Question,
  Unresolved altısı birden). Bilinmeyen statü fail-closed.
- **`searchIssues` maxResults=100'de kesiyor ve SAYFALAMIYOR.** Geniş bir JQL'i
  istemcide süzmek sessiz veri kaybı demek; süzgeci JQL'e taşı. Bekleyen-release
  sorgusu ayrıca `updated ASC` sıralı — en bayatlar bandın var olma sebebi.
- **`mergeable: UNKNOWN` conflict değildir** — GitHub tembel hesaplıyor, ikinci
  sorguda `MERGEABLE`'a dönüyor. Yalnızca `CONFLICTING` engel sayılır.
- **CI yeşilken de merge engelli olabilir:** `reviewDecision: REVIEW_REQUIRED`.
- **`node` ve `gh` PATH'te aranmaz.** Finder'dan açılan GUI uygulaması shell
  PATH'ini görmez; Homebrew de Apple Silicon'da `/opt/homebrew`, Intel'de
  `/usr/local` altında. İkisi de aday listesinden çözülüyor (`resolveExecutable`).
- **Kod klasörünün yolu Swift'e gömülü değil** — `build-app.sh` bundle'a
  `Contents/Resources/appdir` olarak yazıyor, böylece klon her yerde olabilir.
- **Geçersiz Jira token'ı aramada HATA VERMİYOR.** Jira geçersiz kimliği anonim
  sayıp `HTTP 200 + {"issues":[]}` dönüyor (aynı token `/myself`'te 401 alıyor).
  Yanlış token giren kullanıcı bu yüzden hata değil bomboş bir pano görüyordu.
  Artık sonuç boşken kimlik doğrulanıyor — dolu panoda ek istek yok.
- **Keychain kaydını YAZAN uygulama OKUMALI.** Uygulama `security` komutuyla
  oluşturulmuş bir kaydı okumaya kalkarsa macOS izin penceresi açıyor (ölçüldü:
  komut diyalog bekleyip asılı kaldı). Bu yüzden kurulum ekranının yazdığı
  kayıtlar `tokensOwnedByApp` bayrağıyla işaretleniyor ve uygulama yalnızca
  onları okuyup fetch.mjs'e **stdin ile** veriyor (argv `ps` çıktısında görünür).
  Elle kurulmuş eski kayıtlarda uygulama keychain'e hiç dokunmuyor.
- **Sprint alanının id'si kuruluma göre değişiyor** — yaygın varsayım `customfield_10020`
  ama her Jira'da farklı olabiliyor. Bu yüzden runtime'da `/rest/api/3/field` ile
  keşfedilip config'e yazılıyor; hiçbir yerde hard-code edilmiyor.
- **`security` komutunun stderr'i stdout'a karışırsa JSON parse patlar** →
  `stdio: ["ignore", "pipe", "ignore"]`.
- **WKWebView `isFlipped == true`** — y yukarıdan sayılır.
- **Sürükleme şeridinde koşulsuz `performDrag` o şeritteki her düğmeyi öldürür.**
  `mouseDown`'da tıklama/sürükleme ayrımı şart.
- **`evaluateJavaScript(..., completionHandler: nil)` hatayı yutar.** Sayfa
  "yükleniyor"da takılıp hiçbir iz bırakmıyordu.
- **`open` ile açılan uygulamanın NSLog'u birleşik log'a düşmüyor** — teşhis için
  dosyaya yaz.

## Lisans

Kişisel kullanım.
