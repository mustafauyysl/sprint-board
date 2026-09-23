// Sprint Board — masaüstü penceresi.
//
// Übersicht'ten buraya taşındı: Übersicht 1.6.82 macOS 26'da widget'a hiç mouse
// olayı geçirmiyordu (minimal test widget'ıyla kanıtlandı), bu yüzden tıklama,
// sürükleme ve link açma imkânsızdı. Kendi NSWindow'umuzda üçü de çalışıyor.
//
// Veri katmanı değişmedi: fetch.mjs + lib.mjs aynen kullanılıyor.

import Cocoa
import WebKit
import Security
import CommonCrypto
import Network

/// Homebrew Apple Silicon'da /opt/homebrew, Intel Mac'te /usr/local altında kurulu.
/// Finder'dan açılan bir GUI uygulaması shell PATH'ini GÖRMEZ (/usr/bin:/bin ile
/// sınırlı kalır), o yüzden "node PATH'tedir" varsayamıyoruz — adayları yokluyoruz.
let BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
let JIRA_KEYCHAIN = "sprint-board-jira"

func findExecutable(_ name: String) -> String? {
    for dir in BIN_DIRS {
        let path = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    return nil
}

/// Veri katmanının (fetch.mjs / lib.mjs / view.html) nerede olduğu.
///
/// Üç mod, bu sırayla:
///  1. `appdir` dosyası — GELİŞTİRME derlemesi. build-app.sh repo yolunu yazar,
///     böylece view.html'i düzenleyip sadece uygulamayı yeniden başlatmak yetiyor.
///  2. Bundle'ın kendi Resources'ı — DAĞITIM derlemesi (--release). Dosyalar
///     .app'in İÇİNDE, yani indiren kişinin repoyu klonlamasına gerek yok.
///  3. Eski sabit yol — geriye dönük uyumluluk.
func resolveAppDir() -> String {
    let fm = FileManager.default

    if let url = Bundle.main.url(forResource: "appdir", withExtension: nil),
       let raw = try? String(contentsOf: url, encoding: .utf8) {
        let dir = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !dir.isEmpty, fm.fileExists(atPath: "\(dir)/fetch.mjs") { return dir }
    }

    if let res = Bundle.main.resourcePath, fm.fileExists(atPath: "\(res)/fetch.mjs") {
        return res
    }

    return ("~/.local/share/sprint-board" as NSString).expandingTildeInPath
}

/// Node: ÖNCE bundle'ın içindekini kullan. Dağıtım derlemesi node'u .app'in
/// içine gömüyor, böylece indiren kişinin makinesinde node kurulu olmasına
/// gerek kalmıyor. Bundle'da yoksa (geliştirme derlemesi) sistemde aranır.
func resolveNode() -> String? {
    if let res = Bundle.main.resourcePath {
        let bundled = "\(res)/node"
        if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
    }
    return findExecutable("node")
}

let CONFIG_PATH = (("~/.config/sprint-widget/config.json") as NSString).expandingTildeInPath

/// Kurulum gerekli mi: config dosyasi yoksa ya da Jira token'i keychain'de yoksa.
/// Indirilen uygulama ilk acildiginda ikisi de yok — eskiden bu durumda widget
/// sadece "config okunamadi" hata ekrani gosteriyordu.
func needsSetup() -> Bool {
    guard let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
          let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let email = cfg["email"] as? String, !email.isEmpty,
          email != "sen@sirket.com"           // ornekten kopyalanmis, doldurulmamis
    else { return true }
    // OAuth kurulumunda aranacak sey API token'i degil refresh token.
    if (cfg["authMode"] as? String) == "oauth" {
        return keychainGet(service: JIRA_OAUTH_KEYCHAIN, account: email) == nil
    }
    let service = (cfg["keychainService"] as? String) ?? JIRA_KEYCHAIN
    return keychainGet(service: service, account: email) == nil
}

func keychainGet(service: String, account: String) -> String? {
    let q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
          let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
}

/// Token'i DOGRUDAN keychain'e yazar. Bilerek `security add-generic-password`
/// alt sureci KULLANILMIYOR: token argv'ye dusseydi ps ciktisinda gorunurdu.
@discardableResult
func keychainSet(service: String, account: String, value: String) -> Bool {
    let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)          // varsa uzerine yaz
    var add = base
    add[kSecValueData as String] = Data(value.utf8)
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
}

// --- Atlassian OAuth ----------------------------------------------------
// Neden Worker: Atlassian token ucu `client_secret` ZORUNLU tutuyor (kimlik
// sunucusu `none` kimlik yontemini ilan etmiyor), yani PKCE secret'in YERINE
// gecmiyor. Secret dagitilan .app'e konamayacagi icin degisim Worker'dan
// geciyor. Ayrintili gerekce: CLAUDE.md.
let WORKER_URL = "https://sprint-board-auth.mustafa-uysal.workers.dev"
let ATLASSIAN_CLIENT_ID = "D2jLovDh1jR4h0xezwElLSyWs3QpUe0w"
let OAUTH_PORT: UInt16 = 53682
let OAUTH_SCOPES = "read:jira-work read:jira-user read:me offline_access"
/// Refresh token burada. Access token bellekte tutuluyor — 1 saatlik, diske
/// yazmanin anlami yok.
let JIRA_OAUTH_KEYCHAIN = "sprint-board-jira-oauth"

/// Dosyaya teshis. VARSAYILAN OLARAK KAPALI: yalnizca /tmp/sb-debug.log
/// ONCEDEN VARSA yazar, yani `touch /tmp/sb-debug.log` ile aciliyor.
///
/// Neden dosya: `open` ile acilan uygulamanin NSLog'u birlesik loga dusmuyor
/// (README'deki tuzak). Terminalden calistirmak da farkli bir ortam oldugu
/// icin sorunu maskeleyebiliyor.
func dbg(_ s: String) {
    let path = "/tmp/sb-debug.log"
    guard let h = FileHandle(forWritingAtPath: path) else { return }
    h.seekToEndOfFile()
    h.write(Data("\(Date()) \(s)\n".utf8))
    h.closeFile()
}

func b64url(_ d: Data) -> String {
    d.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func randomB64url(_ bytes: Int) -> String {
    var b = [UInt8](repeating: 0, count: bytes)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
    return b64url(Data(b))
}

func sha256B64url(_ s: String) -> String {
    var h = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    let d = Data(s.utf8)
    d.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(d.count), &h) }
    return b64url(Data(h))
}

/// POST JSON, JSON al. Senkron — zaten arka plan kuyrugundan cagriliyor.
func postJSON(_ urlString: String, _ body: [String: Any]) -> [String: Any]? {
    guard let url = URL(string: urlString),
          let data = try? JSONSerialization.data(withJSONObject: body) else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    req.timeoutInterval = 25
    var out: [String: Any]?
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { d, _, _ in
        if let d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { out = j }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 30)
    return out
}

func getJSON(_ urlString: String, bearer: String) -> Any? {
    guard let url = URL(string: urlString) else { return nil }
    var req = URLRequest(url: url)
    req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    req.timeoutInterval = 25
    var out: Any?
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { d, _, _ in
        if let d { out = try? JSONSerialization.jsonObject(with: d) }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 30)
    return out
}

/// Tarayicinin dondugu tek istegi yakalayan asgari HTTP dinleyicisi.
///
/// Neden ham soket: tek bir GET yakalayip kapanacak bir sey icin sunucu
/// cercevesi tasimak anlamsiz. Yalnizca 127.0.0.1'e baglaniyor.
final class CallbackListener {
    private var listener: NWListener?

    /// `onCode` query parametrelerini verir; dinleyici ilk istekten sonra kapanir.
    func start(port: UInt16, onCode: @escaping ([String: String]) -> Void) -> Bool {
        guard let l = try? NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!) else { return false }
        listener = l
        l.newConnectionHandler = { [weak self] conn in
            conn.start(queue: .global())
            conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                defer { conn.cancel(); self?.stop() }
                guard let data, let req = String(data: data, encoding: .utf8),
                      let line = req.split(separator: "\r\n").first,
                      let path = line.split(separator: " ").dropFirst().first
                else { return }

                var params: [String: String] = [:]
                if let q = path.split(separator: "?").dropFirst().first {
                    for pair in q.split(separator: "&") {
                        let kv = pair.split(separator: "=", maxSplits: 1)
                        if kv.count == 2 {
                            params[String(kv[0])] = String(kv[1]).removingPercentEncoding ?? String(kv[1])
                        }
                    }
                }

                let html = """
                <!doctype html><meta charset="utf-8">
                <body style="font-family:system-ui;background:#06120a;color:#9bffb0;
                             display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
                <div style="text-align:center">
                  <h2 style="letter-spacing:.18em;color:#39ff14">\u{2694} SPRINT BOARD</h2>
                  <p>Giri\u{15F} al\u{131}nd\u{131}. Bu sekmeyi kapatabilirsin.</p>
                </div>
                """
                let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
                           "Content-Length: \(html.utf8.count)\r\nConnection: close\r\n\r\n" + html
                conn.send(content: Data(resp.utf8), completion: .contentProcessed { _ in
                    onCode(params)
                })
            }
        }
        l.start(queue: .global())
        return true
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }
}

let APP_DIR = resolveAppDir()
let NODE = resolveNode()
/// Cloudflare WARP TLS'i dinliyor; Node macOS keychain'ini okumadığı için
/// WARP'ın kök sertifikası olmadan her fetch "fetch failed" ile düşüyor.
let WARP_CA = "/usr/local/etc/cloudflare-zt/allCAbundle.pem"
let REFRESH_SECONDS: TimeInterval = 30 * 60
let NOTES_PATH = ("~/.local/state/sprint-widget/notes.json" as NSString).expandingTildeInPath
let MAX_NOTES = 6
let NOTE_LIMIT = 140

/// Üst şeritten tutunca pencereyi taşır; gerisi normal tıklama olarak WebView'e gider.
/// (CSS'teki -webkit-app-region Electron'a özgü, WKWebView'de çalışmıyor —
///  isMovableByWindowBackground da WebView olayları tükettiği için yetmiyor.)
// Menü çubuğu ikonu — sürükleme sınıfının işi değil, üst seviyede duruyor.
/// Menü çubuğu için kılıç. Template olduğu için siyah çizilir; renklendirmeyi
/// macOS yapar. Font'a bağlı değil — ⚔ glifi Apple Color Emoji'ye düşebiliyor.
func swordIcon(_ side: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: x * side, y: y * side)
        }
        let blade = NSBezierPath()
        blade.move(to: p(0.50, 0.98))
        blade.line(to: p(0.60, 0.76))
        blade.line(to: p(0.588, 0.40))
        blade.line(to: p(0.412, 0.40))
        blade.line(to: p(0.40, 0.76))
        blade.close()

        let guardBar = NSBezierPath(roundedRect: NSRect(x: 0.16 * side, y: 0.315 * side,
                                                       width: 0.68 * side, height: 0.085 * side),
                                    xRadius: 0.04 * side, yRadius: 0.04 * side)
        let grip = NSBezierPath(roundedRect: NSRect(x: 0.442 * side, y: 0.115 * side,
                                                    width: 0.116 * side, height: 0.20 * side),
                                xRadius: 0.04 * side, yRadius: 0.04 * side)
        let pommel = NSBezierPath(ovalIn: NSRect(x: 0.40 * side, y: 0.015 * side,
                                                 width: 0.20 * side, height: 0.13 * side))
        NSColor.black.setFill()
        for path in [blade, guardBar, grip, pommel] { path.fill() }
        return true
    }
    img.isTemplate = true          // açık/koyu menü çubuğuna kendi uyum sağlar
    return img
}

final class DragWebView: WKWebView {
    static let handleHeight: CGFloat = 34

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        // WKWebView isFlipped=TRUE: y YUKARIDAN sayılır (ölçüldü: başlığa tıklayınca y=23).
        // Ters varsayım yüzünden performDrag hiç çağrılmıyordu.
        guard p.y < DragWebView.handleHeight else {
            super.mouseDown(with: event)
            return
        }

        // Şeritte KOŞULSUZ performDrag çağırmak, başlıktaki ⟳ yenileme düğmesini
        // tıklanamaz yapıyordu: olay sürüklemeye gidip sayfaya hiç ulaşmıyordu.
        // Bir sonraki olaya bakıp ayırt ediyoruz — sürükleme mi, düz tıklama mı.
        // dequeue:false => olay kuyrukta kalır, normal işleyiş bozulmaz.
        let next = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged],
                                   until: .distantFuture,
                                   inMode: .eventTracking,
                                   dequeue: false)
        if next?.type == .leftMouseDragged {
            window?.performDrag(with: event)
        } else {
            super.mouseDown(with: event)   // tıklama: sayfaya geçsin
        }
    }
}

final class BoardWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: BoardWindow!
    var web: DragWebView!
    var timer: Timer?
    var statusItem: NSStatusItem!
    var retryTimer: Timer?
    var retryCount = 0
    var ready = false
    var pendingJSON: String?

    // MARK: pencere

    func applicationDidFinishLaunching(_ note: Notification) {
        // SIGPIPE'i YOKSAY. fetch.mjs'e token'lari stdin'den veriyoruz; alt
        // surec bir hatayla ERKEN CIKARSA borunun okuma ucu kapaniyor ve
        // yazma islemi uygulamayi olduruyor (olculdu: exit 141 = 128+13).
        // Yoksayinca yazma sessizce EPIPE ile basarisiz oluyor, surec yasiyor.
        signal(SIGPIPE, SIG_IGN)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "sb")
        // Şeffaf zemin: kartın kendi arka planı görünsün, pencere dikdörtgeni değil.
        cfg.setValue(false, forKey: "drawsBackground")

        let frame = savedFrame()
        window = BoardWindow(contentRect: frame, styleMask: [.borderless, .resizable],
                             backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isMovableByWindowBackground = true
        // NOT: masaüstü seviyesi (desktopIcon) denendi — pencere mouse olayı almıyordu.
        // Normal seviye: diğer pencerelerle aynı düzlemde, tıklama/sürükleme çalışır.
        window.level = .normal
        // .canJoinAllSpaces DENENDI ve KALDIRILDI: widget her Space'te göründüğü için
        // tam ekran uygulamaların üstüne çıkıyordu. Masaüstü Space'inde kalsın.
        window.collectionBehavior = [.stationary, .ignoresCycle, .fullScreenNone]

        web = DragWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window.contentView!.addSubview(web)

        if needsSetup() {
            onSetupScreen = true
            loadPage("setup.html")
        } else {
            loadPage("view.html")
        }

        // Menü çubuğu simgesi: Dock ikonu olmadığı için (LSUIElement) uygulamayı
        // kapatmanın TEK arayüz yolu bu. Olmazsa terminalden pkill gerekirdi.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // METİN DEĞİL, template NSImage: `button.title = "⚔"` menü çubuğunda ikon
        // gibi değil küçücük bir yazı karakteri gibi görünüyordu ve menü fontuna
        // bağlı kalıyordu. Template image menü yüksekliğine oturur ve açık/koyu
        // menü çubuğunda rengini kendisi ayarlar.
        statusItem.button?.image = swordIcon(18)
        statusItem.button?.toolTip = "Sprint Board"
        let menu = NSMenu()
        let mRefresh = NSMenuItem(title: "Şimdi yenile", action: #selector(menuRefresh), keyEquivalent: "r")
        let mFront = NSMenuItem(title: "Widget'ı öne getir", action: #selector(menuFront), keyEquivalent: "")
        let mSetup = NSMenuItem(title: "Ayarlar…", action: #selector(menuSetup), keyEquivalent: "")
        for m in [mRefresh, mFront, mSetup] { m.target = self; menu.addItem(m) }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Sprint Board'dan çık", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu

        window.orderFront(nil)
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification,
                                               object: window, queue: .main) { [weak self] _ in
            self?.saveFrame()
        }

        timer = Timer.scheduledTimer(withTimeInterval: REFRESH_SECONDS, repeats: true) { [weak self] _ in
            self?.reload()
        }
        // Uykudan uyanınca hemen tazele: Timer uyku boyunca ilerlemiyor, uyanışta
        // veri saatlerce bayat kalabiliyordu.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.reload() }
        reload()
    }

    /// Kurulum ekranını yeniden açar — token süresi dolduğunda ya da hesap
    /// değiştiğinde config'i elle düzenlemek gerekmesin diye.
    @objc func menuSetup() {
        onSetupScreen = true
        loadPage("setup.html")
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc func menuRefresh() { reload() }

    /// Pencere başka pencerelerin altında kaldıysa geri çağırır.
    @objc func menuFront() {
        window.orderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func savedFrame() -> NSRect {
        let d = UserDefaults.standard
        let x = d.object(forKey: "sbX") as? Double
        let y = d.object(forKey: "sbY") as? Double
        let h = d.object(forKey: "sbH") as? Double ?? 420
        guard let screen = NSScreen.main else {
            return NSRect(x: 40, y: 40, width: 430, height: h)
        }
        // Varsayılan: sol üst köşe (macOS'ta y aşağıdan yukarı sayılır).
        let vf = screen.visibleFrame
        return NSRect(x: x ?? (vf.minX + 40),
                      y: y ?? (vf.maxY - h - 40),
                      width: 430, height: h)
    }

    func saveFrame() {
        let f = window.frame
        let d = UserDefaults.standard
        d.set(Double(f.minX), forKey: "sbX")
        d.set(Double(f.minY), forKey: "sbY")
        d.set(Double(f.height), forKey: "sbH")
    }

    // MARK: veri

    /// Finder'dan açılan bir GUI uygulaması shell profilini görmez: NODE_EXTRA_CA_CERTS
    /// gelmez, PATH da /usr/bin:/bin ile sınırlı kalır. Node'a WARP kök sertifikasını
    /// elle veriyoruz, yoksa fetch.mjs terminalde çalışıp widget'ta çalışmıyor.
    func childEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        if env["NODE_EXTRA_CA_CERTS"] == nil,
           FileManager.default.fileExists(atPath: WARP_CA) {
            env["NODE_EXTRA_CA_CERTS"] = WARP_CA
        }
        return env
    }

    /// Kurulum ekranı açıkken veri katmanı çalıştırılmamalı: setup.html'de
    /// sbRender yok, push oraya gidince "A JavaScript exception occurred" ile
    /// düşüyordu — üstelik config henüz yazılmadığı için fetch zaten hata döner.
    var onSetupScreen = false

    /// Bundle/repo içindeki bir HTML sayfasını yükler.
    func loadPage(_ name: String) {
        let url = URL(fileURLWithPath: "\(APP_DIR)/\(name)")
        web.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: APP_DIR))
    }

    /// Kurulum ekranından gelen değerler.
    ///
    /// İş bölümü: config'i `fetch.mjs --setup` yazıyor (doğrulama lib.mjs'te,
    /// testli), token'ları BU taraf doğrudan keychain'e koyuyor. Böylece hiçbir
    /// sır alt sürecin argv'sine ya da stdin'ine düşmüyor.
    func saveSetup(_ v: [String: Any]) {
        let str = { (k: String) -> String in
            (v[k] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let jiraToken = str("jiraToken")
        if jiraToken.isEmpty { setupFailed(["Jira token gerekli"]); return }

        guard let node = NODE else {
            setupFailed(["node bulunamadı"]); return
        }

        let payload: [String: String] = [
            "host": str("host"), "email": str("email"), "githubOrg": str("githubOrg"),
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            setupFailed(["kurulum verisi hazırlanamadı"]); return
        }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["\(APP_DIR)/fetch.mjs", "--setup"]
        p.currentDirectoryURL = URL(fileURLWithPath: APP_DIR)
        p.environment = childEnvironment()
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch {
            setupFailed(["kurulum çalıştırılamadı: \(error)"]); return
        }
        inPipe.fileHandleForWriting.write(body)
        inPipe.fileHandleForWriting.closeFile()
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()

        guard let res = try? JSONSerialization.jsonObject(with: out) as? [String: Any],
              res["ok"] as? Bool == true else {
            let errs = (try? JSONSerialization.jsonObject(with: out) as? [String: Any])
                .flatMap { $0?["errors"] as? [String] } ?? ["config yazılamadı"]
            setupFailed(errs); return
        }

        // Config yazıldı; token'lar şimdi keychain'e.
        let email = str("email")
        if !keychainSet(service: JIRA_KEYCHAIN, account: email, value: jiraToken) {
            setupFailed(["Jira token keychain'e yazılamadı"]); return
        }
        let ghToken = str("githubToken")
        if !ghToken.isEmpty {
            keychainSet(service: "sprint-board-github", account: email, value: ghToken)
        }

        DispatchQueue.main.async {
            self.onSetupScreen = false
            self.loadPage("view.html")
            self.reload()
        }
    }

    func setupFailed(_ errors: [String]) {
        let json = (try? JSONSerialization.data(withJSONObject: ["errors": errors]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"errors":["bilinmeyen hata"]}"#
        DispatchQueue.main.async {
            self.web.evaluateJavaScript("window.sbSetupResult(\(json))") { _, err in
                if let err { NSLog("sbSetupResult: \(err)") }
            }
        }
    }

    // MARK: Atlassian OAuth

    /// Access token 1 saatlik; diske yazmıyoruz, süreç boyunca bellekte.
    var jiraAccessToken: String?
    var jiraAccessExpiry: Date?
    var oauthListener: CallbackListener?

    /// "Atlassian ile giriş yap" — PKCE üret, dinlemeye başla, tarayıcıyı aç.
    func startAtlassianLogin() {
        let verifier = randomB64url(32)
        let state = randomB64url(12)
        let redirect = "http://127.0.0.1:\(OAUTH_PORT)/callback"

        let listener = CallbackListener()
        oauthListener = listener
        let started = listener.start(port: OAUTH_PORT) { [weak self] params in
            guard let self else { return }
            // state kontrolü CSRF için: dönen isteğin bizim başlattığımız akışa
            // ait olduğunu doğrulayan tek şey.
            guard params["state"] == state, let code = params["code"] else {
                self.setupFailed(["Giriş doğrulanamadı (state uyuşmadı)"]); return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                self.finishAtlassianLogin(code: code, verifier: verifier, redirect: redirect)
            }
        }
        guard started else {
            setupFailed(["Port \(OAUTH_PORT) dinlenemedi — başka bir uygulama kullanıyor olabilir"])
            return
        }

        var c = URLComponents(string: "https://auth.atlassian.com/authorize")!
        c.queryItems = [
            .init(name: "audience", value: "api.atlassian.com"),
            .init(name: "client_id", value: ATLASSIAN_CLIENT_ID),
            .init(name: "scope", value: OAUTH_SCOPES),
            .init(name: "redirect_uri", value: redirect),
            .init(name: "state", value: state),
            .init(name: "response_type", value: "code"),
            .init(name: "prompt", value: "consent"),
            .init(name: "code_challenge", value: sha256B64url(verifier)),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        if let url = c.url { NSWorkspace.shared.open(url) }
    }

    /// Kod geldi: Worker'dan token al, siteyi ve kimliği keşfet, config'i yaz.
    func finishAtlassianLogin(code: String, verifier: String, redirect: String) {
        guard let tok = postJSON(WORKER_URL + "/token",
                ["code": code, "code_verifier": verifier, "redirect_uri": redirect]),
              let access = tok["access_token"] as? String,
              let refresh = tok["refresh_token"] as? String else {
            setupFailed(["Atlassian token alınamadı"]); return
        }

        // Kullanıcıya adresi ve e-postayı sormamamızı sağlayan iki çağrı.
        guard let sites = getJSON("https://api.atlassian.com/oauth/token/accessible-resources", bearer: access) as? [[String: Any]],
              let site = sites.first,
              let cloudId = site["id"] as? String,
              let siteURL = site["url"] as? String,
              let host = URL(string: siteURL)?.host else {
            setupFailed(["Jira siteniz bulunamadı"]); return
        }
        let me = getJSON("https://api.atlassian.com/me", bearer: access) as? [String: Any]
        let email = (me?["email"] as? String) ?? ""

        guard keychainSet(service: JIRA_OAUTH_KEYCHAIN, account: email.isEmpty ? host : email, value: refresh) else {
            setupFailed(["Giriş keychain'e yazılamadı"]); return
        }

        // Eşikler/sesler gibi varsayılanlar örnekten; kimlik bilgileri girişten.
        var cfg = (try? JSONSerialization.jsonObject(with: Data(contentsOf:
                    URL(fileURLWithPath: "\(APP_DIR)/config.example.json")))) as? [String: Any] ?? [:]
        if let existing = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
           let old = try? JSONSerialization.jsonObject(with: existing) as? [String: Any] {
            cfg = old                       // mevcut ayarları koru, sadece kimliği güncelle
        }
        cfg["host"] = host
        cfg["email"] = email
        cfg["cloudId"] = cloudId
        cfg["authMode"] = "oauth"
        cfg["tokensOwnedByApp"] = true
        if let data = try? JSONSerialization.data(withJSONObject: cfg, options: .prettyPrinted) {
            try? FileManager.default.createDirectory(
                atPath: (CONFIG_PATH as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: CONFIG_PATH))
        }

        jiraAccessToken = access
        jiraAccessExpiry = Date().addingTimeInterval(TimeInterval((tok["expires_in"] as? Int) ?? 3600))

        DispatchQueue.main.async {
            self.onSetupScreen = false
            self.loadPage("view.html")
            self.reload()
        }
    }

    /// Geçerli access token; dolmuşsa Worker üzerinden sessizce yeniler.
    /// Tarayıcı AÇILMAZ — yenileme tamamen sunucu-sunucu.
    func currentJiraAccessToken(email: String) -> String? {
        if let t = jiraAccessToken, let e = jiraAccessExpiry, e > Date().addingTimeInterval(60) {
            dbg("token: bellekten"); return t
        }
        guard let refresh = keychainGet(service: JIRA_OAUTH_KEYCHAIN, account: email) else {
            dbg("token: keychain'de refresh YOK (account=\(email))"); return nil
        }
        guard let tok = postJSON(WORKER_URL + "/refresh", ["refresh_token": refresh]) else {
            dbg("token: Worker /refresh CEVAP VERMEDI"); return nil
        }
        guard let access = tok["access_token"] as? String else {
            dbg("token: /refresh access_token dondurmedi -> \(tok.keys.sorted())"); return nil
        }
        dbg("token: refresh ile yenilendi")

        // SIRA KRİTİK: Atlassian refresh token'ları DÖNÜYOR. Yenisini
        // KULLANMADAN ÖNCE kaydetmezsek ve arada bir şey olursa zincir kopar,
        // kullanıcı yeniden giriş yapmak zorunda kalır.
        if let newRefresh = tok["refresh_token"] as? String {
            keychainSet(service: JIRA_OAUTH_KEYCHAIN, account: email, value: newRefresh)
        }
        jiraAccessToken = access
        jiraAccessExpiry = Date().addingTimeInterval(TimeInterval((tok["expires_in"] as? Int) ?? 3600))
        return access
    }

    /// Token'ları keychain'den okuyup fetch.mjs'e verilecek JSON'u hazırlar.
    ///
    /// Okumayı UYGULAMA yapıyor, `security` alt süreci değil: kurulum ekranının
    /// yazdığı kaydı yazan uygulama okuduğu için macOS izin sormuyor. `security`
    /// ayrı bir binary olduğundan onun okuması diyalog açtırıyordu.
    func tokenPayload() -> Data {
        var out: [String: String] = [:]
        dbg("tokenPayload cagrildi")
        if let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
           let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
           // SADECE kurulum ekranının yazdığı kayıtlar. Elle `security` ile
           // oluşturulmuş eski bir kaydı uygulama okumaya kalkarsa macOS izin
           // penceresi açar (yaşandı); o durumda keychain'e hiç dokunmuyoruz ve
           // fetch.mjs eski `security` yoluna düşüyor.
           cfg["tokensOwnedByApp"] as? Bool == true,
           let email = cfg["email"] as? String, !email.isEmpty {
            if (cfg["authMode"] as? String) == "oauth" {
                // Suresi dolmussa burada sessizce yenileniyor; tarayici acilmaz.
                if let at = currentJiraAccessToken(email: email) { out["jiraAccessToken"] = at }
                else { dbg("tokenPayload: OAuth ama access token ALINAMADI") }
            } else {
                let jiraSvc = (cfg["keychainService"] as? String) ?? JIRA_KEYCHAIN
                if let t = keychainGet(service: jiraSvc, account: email) { out["jiraToken"] = t }
            }
            let ghSvc = (cfg["githubKeychainService"] as? String) ?? "sprint-board-github"
            if let g = keychainGet(service: ghSvc, account: email) { out["githubToken"] = g }
        }
        // Sürümü YALNIZCA dağıtım derlemesinde bildiriyoruz. Geliştirme
        // derlemesinde bundle'da `appdir` var; orada her yenilemede
        // "yeni sürüm var" demesi sadece gürültü olurdu.
        if Bundle.main.url(forResource: "appdir", withExtension: nil) == nil,
           let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            out["appVersion"] = v
        }
        return (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8)
    }

    /// fetch.mjs'i arka planda çalıştırıp JSON'u web tarafına verir.
    func reload() {
        if onSetupScreen { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            guard let node = NODE else {
                self.push(#"{"ok":false,"error":"node bulunamadı — /opt/homebrew/bin, /usr/local/bin ve /usr/bin altında aradım"}"#)
                return
            }
            // Payload'u alt sureci BASLATMADAN ONCE hazirla. OAuth modunda
            // burada bir ag istegi (token yenileme) olabiliyor; sonra
            // hazirlansaydi fetch.mjs bos boruyu okuyup token'siz devam ederdi.
            let payload = self.tokenPayload()

            let p = Process()
            p.executableURL = URL(fileURLWithPath: node)
            p.arguments = ["\(APP_DIR)/fetch.mjs"]
            p.currentDirectoryURL = URL(fileURLWithPath: APP_DIR)
            p.environment = childEnvironment()
            let inPipe = Pipe()
            p.standardInput = inPipe
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch {
                self.push(#"{"ok":false,"error":"fetch.mjs çalıştırılamadı: \#(error)"}"#)
                return
            }
            // Token'lar argv'ye DEĞİL stdin'e: argv `ps` çıktısında görünürdü.
            // Alt süreç çoktan ölmüşse yazma EPIPE verir; SIGPIPE yoksayıldığı
            // için süreç yaşar, hatayı burada yutuyoruz.
            let handle = inPipe.fileHandleForWriting
            do { try handle.write(contentsOf: payload) } catch { }
            try? handle.close()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let out = String(data: data, encoding: .utf8) ?? ""
            dbg("fetch cikti (\(out.count) bayt): \(out.prefix(240))")
            self.push(out.isEmpty ? #"{"ok":false,"error":"fetch.mjs boş çıktı verdi"}"# : out)
        }
    }

    /// Başarısız yenilemeyi 30 dk beklemeden tekrar dener.
    /// Tek bir ağ kesintisi (uyanış anında wifi gelmemiş olması gibi) yüzünden
    /// widget yarım saat hata ekranında kalıyordu.
    func scheduleRetry() {
        retryTimer?.invalidate()
        guard retryCount < 3 else { return }
        retryCount += 1
        retryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            self?.reload()
        }
    }

    func push(_ json: String) {
        if onSetupScreen { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            let ok = (try? JSONSerialization.jsonObject(with: Data(json.utf8)))
                .flatMap { ($0 as? [String: Any])?["ok"] as? Bool } ?? false
            if ok { self.retryCount = 0; self.retryTimer?.invalidate() } else { self.scheduleRetry() }

            guard self.ready else { self.pendingJSON = json; return }
            let escaped = json.data(using: .utf8).flatMap {
                String(data: try! JSONSerialization.data(withJSONObject: [String(data: $0, encoding: .utf8)!],
                                                         options: [.fragmentsAllowed]), encoding: .utf8)
            } ?? "[\"{}\"]"
            // escaped: ["<json metni>"] -> [0] ile geri alıp parse ediyoruz
            // Hata YUTULMAZ: completionHandler nil iken sayfa "yükleniyor"da takılıp
            // kalıyordu ve hiçbir iz bırakmıyordu. Artık log'a düşüyor.
            self.web.evaluateJavaScript("window.sbRender(JSON.parse(\(escaped)[0]))") { _, err in
                if let err { NSLog("SB: sbRender hatasi: \(err.localizedDescription)") }
            }
        }
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        ready = true
        if let j = pendingJSON { pendingJSON = nil; push(j) }
        pushNotes()
    }

    func webView(_ w: WKWebView, didFail nav: WKNavigation!, withError e: Error) {
        NSLog("SB: navigasyon hatasi: \(e.localizedDescription)")
    }

    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
        NSLog("SB: sayfa acilamadi: \(e.localizedDescription)")
    }

    // MARK: notlar (dosyada; localStorage file:// origin'de güvenilir değil)

    func readNotes() -> [[String: Any]] {
        guard let d = FileManager.default.contents(atPath: NOTES_PATH),
              let a = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return [] }
        return a
    }

    func writeNotes(_ notes: [[String: Any]]) {
        let dir = (NOTES_PATH as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if let d = try? JSONSerialization.data(withJSONObject: notes, options: [.prettyPrinted]) {
            try? d.write(to: URL(fileURLWithPath: NOTES_PATH))
        }
    }

    func pushNotes() {
        let notes = readNotes()
        guard let d = try? JSONSerialization.data(withJSONObject: notes),
              let j = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.web.evaluateJavaScript("window.sbNotes(\(j))", completionHandler: nil)
        }
    }

    func addNote(_ raw: String) {
        let text = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(NOTE_LIMIT))
        guard !text.isEmpty else { return }
        var notes = readNotes()
        notes.append(["id": "\(Int(Date().timeIntervalSince1970 * 1000))", "text": text])
        if notes.count > MAX_NOTES { notes.removeFirst(notes.count - MAX_NOTES) }
        writeNotes(notes)
        pushNotes()
    }

    func removeNote(_ id: String) {
        writeNotes(readNotes().filter { ($0["id"] as? String) != id })
        pushNotes()
    }

    // MARK: web -> swift köprüsü

    func userContentController(_ c: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let body = msg.body as? [String: Any] else { return }

        if let urlStr = body["open"] as? String, let url = URL(string: urlStr),
           url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        if body["refresh"] != nil { reload() }
        if body["atlassianLogin"] != nil {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.startAtlassianLogin() }
        }
        if let v = body["setupSave"] as? [String: Any] {
            // Alt süreç + ağ işi: ana thread'i kilitleme.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.saveSetup(v) }
        }
        if let t = body["noteAdd"] as? String { addNote(t) }
        if let i = body["noteDel"] as? String { removeNote(i) }
        if let h = body["height"] as? Double, h > 60 {
            var f = window.frame
            let top = f.maxY                    // üst kenarı sabit tut, aşağı doğru büyü
            f.size.height = CGFloat(h)
            f.origin.y = top - CGFloat(h)
            window.setFrame(f, display: true)
            saveFrame()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // Dock'ta ikon yok
app.run()
