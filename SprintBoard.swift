// Sprint Board — the desktop window.
//
// Moved here from Übersicht: Übersicht 1.6.82 on macOS 26 delivered no mouse
// events to the widget at all (proven with a minimal test widget), which made
// clicking, dragging and opening links impossible. In our own NSWindow all three
// work.
//
// The data layer is unchanged: fetch.mjs + lib.mjs are used as-is.

import Cocoa
import WebKit
import Security
import CommonCrypto
import Network

/// Homebrew installs under /opt/homebrew on Apple Silicon and /usr/local on Intel.
/// A GUI app launched from Finder does NOT see the shell PATH (it is limited to
/// /usr/bin:/bin), so we cannot assume "node is on PATH" — we probe the candidates.
let BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
let JIRA_KEYCHAIN = "sprint-board-jira"

func findExecutable(_ name: String) -> String? {
    for dir in BIN_DIRS {
        let path = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    return nil
}

/// Where the data layer (fetch.mjs / lib.mjs / view.html) lives.
///
/// Three modes, in this order:
///  1. An `appdir` file — a DEVELOPMENT build. build-app.sh writes the repo path,
///     so editing view.html only requires restarting the app.
///  2. The bundle's own Resources — a DISTRIBUTION build (--release). The files
///     are INSIDE the .app, so whoever downloads it never clones the repo.
///  3. The old fixed path — backwards compatibility.
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

/// Node: prefer the one INSIDE the bundle. A distribution build embeds node in
/// the .app so whoever downloads it does not need node installed. When it is not
/// in the bundle (a development build) we look for it on the system.
func resolveNode() -> String? {
    if let res = Bundle.main.resourcePath {
        let bundled = "\(res)/node"
        if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
    }
    return findExecutable("node")
}

let CONFIG_PATH = (("~/.config/sprint-widget/config.json") as NSString).expandingTildeInPath

/// Is setup needed: no config file, or no Jira token in the keychain.
/// On a downloaded app's first launch neither exists — the widget used to show
/// nothing but a "could not read config" error screen in that case.
func needsSetup() -> Bool {
    guard let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
          let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let email = cfg["email"] as? String, !email.isEmpty,
          // Copied from the example and never filled in: the setup screen fills the
          // email in from /me, so a config still holding the example value has not
          // been through sign-in.
          email != "you@company.com"
    else { return true }
    // In an OAuth setup what we look for is the refresh token, not an API token.
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

/// Writes the token DIRECTLY to the keychain. The `security add-generic-password`
/// subprocess is deliberately NOT USED: a token in argv would show up in `ps` output.
@discardableResult
func keychainSet(service: String, account: String, value: String) -> Bool {
    let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)          // overwrite any existing item
    var add = base
    add[kSecValueData as String] = Data(value.utf8)
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
}

// --- Atlassian OAuth ----------------------------------------------------
// Why a Worker: Atlassian's token endpoint REQUIRES `client_secret` (its identity
// server does not advertise the `none` auth method), so PKCE does not stand IN PLACE
// OF the secret. The secret cannot ship inside a distributed .app, so the exchange
// goes through the Worker. Full rationale: CLAUDE.md.
let WORKER_URL = "https://sprint-board-auth.mustafa-uysal.workers.dev"
let ATLASSIAN_CLIENT_ID = "D2jLovDh1jR4h0xezwElLSyWs3QpUe0w"
let OAUTH_PORT: UInt16 = 53682
let OAUTH_SCOPES = "read:jira-work read:jira-user read:me offline_access"
/// The refresh token lives here. The access token is kept in memory — it lasts an
/// hour, so writing it to disk is pointless.
let JIRA_OAUTH_KEYCHAIN = "sprint-board-jira-oauth"

/// Diagnostics to a file. OFF BY DEFAULT: it writes only if /tmp/sb-debug.log
/// ALREADY EXISTS, so `touch /tmp/sb-debug.log` turns it on.
///
/// Why a file: an app launched with `open` does not reach the unified log with
/// NSLog (the trap documented in the README). Running it from a terminal is a
/// different environment and can mask the problem instead.
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

/// POST JSON, get JSON back. Synchronous — it is called from a background queue anyway.
/// It also returns the HTTP status, so "no network" can be told apart from
/// "the server refused". status == nil means the request never completed at all.
func postJSON(_ urlString: String, _ body: [String: Any]) -> (status: Int?, json: [String: Any]?) {
    guard let url = URL(string: urlString),
          let data = try? JSONSerialization.data(withJSONObject: body) else { return (nil, nil) }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    req.timeoutInterval = 25
    var status: Int?
    var out: [String: Any]?
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { d, resp, _ in
        status = (resp as? HTTPURLResponse)?.statusCode
        if let d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { out = j }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 30)
    return (status, out)
}

/// The result of getting a token. Telling `temporary` from `needsLogin` is CRITICAL:
/// throwing the user to the sign-in screen while the network is down means destroying
/// a valid session (this happened — it dropped to sign-in whenever the internet was cut).
enum TokenResult {
    case ok(String)
    case needsLogin
    case temporary
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

/// A minimal HTTP listener that catches the single request the browser sends back.
///
/// Why a raw socket: carrying a server framework for something that catches one
/// GET and then shuts down makes no sense. It binds to 127.0.0.1 only.
final class CallbackListener {
    private var listener: NWListener?

    /// `onCode` receives the query parameters; the listener shuts down after the first request.
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
                  <p>Signed in. You can close this tab.</p>
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
/// Cloudflare WARP intercepts TLS, and because Node does not read the macOS
/// keychain every fetch fails with "fetch failed" without WARP's root certificate.
let WARP_CA = "/usr/local/etc/cloudflare-zt/allCAbundle.pem"
let REFRESH_SECONDS: TimeInterval = 30 * 60
let NOTES_PATH = ("~/.local/state/sprint-widget/notes.json" as NSString).expandingTildeInPath
let MAX_NOTES = 6
let NOTE_LIMIT = 140

/// Dragging the top strip moves the window; everything else reaches the WebView
/// as a normal click. (CSS -webkit-app-region is Electron-specific and does
/// nothing in WKWebView — and isMovableByWindowBackground is not enough either,
/// because the WebView consumes the events.)
// Menu bar icon — not the drag class's job, it lives at the top level.
/// The sword for the menu bar. Being a template image it is drawn black and macOS
/// handles the tinting. Font-independent — the ⚔ glyph can fall back to Apple
/// Color Emoji.
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
    img.isTemplate = true          // adapts itself to a light/dark menu bar
    return img
}

final class DragWebView: WKWebView {
    static let handleHeight: CGFloat = 34

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        // WKWebView isFlipped=TRUE: y is measured FROM THE TOP (measured: y=23 on the title).
        // The opposite assumption meant performDrag was never called.
        guard p.y < DragWebView.handleHeight else {
            super.mouseDown(with: event)
            return
        }

        // Calling performDrag UNCONDITIONALLY on the strip made the ⟳ refresh button
        // unclickable: the event went to the drag and never reached the page. We
        // inspect the next event to tell them apart — drag or plain click.
        // dequeue:false => the event stays queued, normal handling is unaffected.
        let next = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged],
                                   until: .distantFuture,
                                   inMode: .eventTracking,
                                   dequeue: false)
        if next?.type == .leftMouseDragged {
            window?.performDrag(with: event)
        } else {
            super.mouseDown(with: event)   // a click: let it through to the page
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

    // MARK: window

    func applicationDidFinishLaunching(_ note: Notification) {
        // IGNORE SIGPIPE. We hand tokens to fetch.mjs over stdin; if the child
        // EXITS EARLY with an error, the read end of the pipe closes and the write
        // kills the app (measured: exit 141 = 128+13). Ignored, the write fails
        // silently with EPIPE instead and the process survives.
        signal(SIGPIPE, SIG_IGN)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "sb")
        // Transparent backing: show the card's own background, not a window rectangle.
        cfg.setValue(false, forKey: "drawsBackground")

        let frame = savedFrame()
        window = BoardWindow(contentRect: frame, styleMask: [.borderless, .resizable],
                             backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.isMovableByWindowBackground = true
        // NOTE: the desktop level (desktopIcon) was tried — the window received no mouse
        // events. Normal level: same plane as other windows, clicks/drags work.
        window.level = .normal
        // .canJoinAllSpaces WAS TRIED AND REMOVED: appearing on every Space put the
        // widget on top of full-screen apps. Keep it on the desktop Space.
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

        // Menu bar item: with no Dock icon (LSUIElement) this is the ONLY UI route to
        // quitting the app. Without it you would need pkill from a terminal.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // A template NSImage, NOT TEXT: `button.title = "⚔"` looked like a tiny character
        // rather than an icon and depended on the menu font. A template image fits the
        // menu height and tints itself for a light/dark menu bar.
        statusItem.button?.image = swordIcon(18)
        statusItem.button?.toolTip = "Sprint Board"
        let menu = NSMenu()
        let mRefresh = NSMenuItem(title: "Refresh now", action: #selector(menuRefresh), keyEquivalent: "r")
        let mFront = NSMenuItem(title: "Bring widget to front", action: #selector(menuFront), keyEquivalent: "")
        let mSetup = NSMenuItem(title: "Settings…", action: #selector(menuSetup), keyEquivalent: "")
        for m in [mRefresh, mFront, mSetup] { m.target = self; menu.addItem(m) }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Sprint Board", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem.menu = menu

        window.orderFront(nil)
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification,
                                               object: window, queue: .main) { [weak self] _ in
            self?.saveFrame()
        }

        timer = Timer.scheduledTimer(withTimeInterval: REFRESH_SECONDS, repeats: true) { [weak self] _ in
            self?.reload()
        }
        // Refresh right after waking: the Timer does not advance while asleep, so on
        // wake the data could sit hours stale.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.reload() }
        reload()
    }

    /// Reopens the setup screen — so an expired token or a changed account never
    /// requires editing config by hand.
    @objc func menuSetup() {
        onSetupScreen = true
        loadPage("setup.html")
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    @objc func menuRefresh() { reload() }

    /// Brings the window back when it has ended up behind other windows.
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
        // Default: top-left corner (on macOS y is measured from the bottom up).
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

    // MARK: data

    /// A GUI app launched from Finder does not see the shell profile: NODE_EXTRA_CA_CERTS
    /// never arrives and PATH stays limited to /usr/bin:/bin. We hand Node the WARP root
    /// certificate explicitly, otherwise fetch.mjs works in a terminal but not in the widget.
    func childEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        if env["NODE_EXTRA_CA_CERTS"] == nil,
           FileManager.default.fileExists(atPath: WARP_CA) {
            env["NODE_EXTRA_CA_CERTS"] = WARP_CA
        }
        return env
    }

    /// The data layer must not run while the setup screen is open: setup.html has no
    /// sbRender, so pushing data there fails with "A JavaScript exception occurred" —
    /// and with no config written yet, fetch would fail anyway.
    var onSetupScreen = false

    /// Loads an HTML page from the bundle/repo.
    func loadPage(_ name: String) {
        let url = URL(fileURLWithPath: "\(APP_DIR)/\(name)")
        web.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: APP_DIR))
    }

    func setupFailed(_ errors: [String]) {
        let json = (try? JSONSerialization.data(withJSONObject: ["errors": errors]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"errors":["unknown error"]}"#
        DispatchQueue.main.async {
            self.web.evaluateJavaScript("window.sbSetupResult(\(json))") { _, err in
                if let err { NSLog("sbSetupResult: \(err)") }
            }
        }
    }

    // MARK: Atlassian OAuth

    /// The access token lasts an hour; never written to disk, only kept in memory.
    var jiraAccessToken: String?
    var jiraAccessExpiry: Date?
    var oauthListener: CallbackListener?
    /// An error raised before the setup screen loaded; shown once the page is ready.
    var pendingSetupError: String?

    /// "Sign in with Atlassian" — generate PKCE, start listening, open the browser.
    func startAtlassianLogin() {
        let verifier = randomB64url(32)
        let state = randomB64url(12)
        let redirect = "http://127.0.0.1:\(OAUTH_PORT)/callback"

        let listener = CallbackListener()
        oauthListener = listener
        let started = listener.start(port: OAUTH_PORT) { [weak self] params in
            guard let self else { return }
            // The state check is the CSRF guard: it is the only thing proving the
            // returning request belongs to the flow we started.
            guard params["state"] == state, let code = params["code"] else {
                self.setupFailed(["Sign-in could not be verified (state mismatch)"]); return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                self.finishAtlassianLogin(code: code, verifier: verifier, redirect: redirect)
            }
        }
        guard started else {
            setupFailed(["Could not listen on port \(OAUTH_PORT) — another app may be using it"])
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

    /// The code arrived: get a token from the Worker, discover site and identity, write config.
    func finishAtlassianLogin(code: String, verifier: String, redirect: String) {
        let r = postJSON(WORKER_URL + "/token",
                         ["code": code, "code_verifier": verifier, "redirect_uri": redirect])
        guard let tok = r.json,
              let access = tok["access_token"] as? String,
              let refresh = tok["refresh_token"] as? String else {
            setupFailed([r.status == nil
                ? "Could not reach Atlassian — check your connection and try again"
                : "Could not obtain an Atlassian token (HTTP \(r.status!))"]); return
        }

        // The two calls that spare the user from typing the site and the email.
        guard let sites = getJSON("https://api.atlassian.com/oauth/token/accessible-resources", bearer: access) as? [[String: Any]],
              let site = sites.first,
              let cloudId = site["id"] as? String,
              let siteURL = site["url"] as? String,
              let host = URL(string: siteURL)?.host else {
            setupFailed(["Could not find your Jira site"]); return
        }
        let me = getJSON("https://api.atlassian.com/me", bearer: access) as? [String: Any]
        let email = (me?["email"] as? String) ?? ""

        guard keychainSet(service: JIRA_OAUTH_KEYCHAIN, account: email.isEmpty ? host : email, value: refresh) else {
            setupFailed(["Could not write the sign-in to the keychain"]); return
        }

        // Defaults like thresholds/sounds come from the example; identity comes from sign-in.
        var cfg = (try? JSONSerialization.jsonObject(with: Data(contentsOf:
                    URL(fileURLWithPath: "\(APP_DIR)/config.example.json")))) as? [String: Any] ?? [:]
        if let existing = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
           let old = try? JSONSerialization.jsonObject(with: existing) as? [String: Any] {
            cfg = old                       // keep existing settings, only refresh identity
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

    /// A valid access token; when expired it is refreshed silently via the Worker.
    /// The browser is NEVER opened — refreshing is purely server-to-server.
    func currentJiraAccessToken(email: String) -> TokenResult {
        if let t = jiraAccessToken, let e = jiraAccessExpiry, e > Date().addingTimeInterval(60) {
            dbg("token: from memory"); return .ok(t)
        }
        guard let refresh = keychainGet(service: JIRA_OAUTH_KEYCHAIN, account: email) else {
            dbg("token: NO refresh in keychain"); return .needsLogin
        }
        let r = postJSON(WORKER_URL + "/refresh", ["refresh_token": refresh])
        guard let status = r.status else {
            // The request never completed: no network. The session may still be VALID.
            dbg("token: /refresh unreachable (network?) -> temporary"); return .temporary
        }
        guard let tok = r.json, let access = tok["access_token"] as? String else {
            // 4xx = the server refused, the session really is dead. 5xx = temporary.
            dbg("token: /refresh HTTP \(status)")
            return (400...499).contains(status) ? .needsLogin : .temporary
        }
        dbg("token: renewed via refresh")

        // ORDER IS CRITICAL: Atlassian ROTATES refresh tokens. If we do not persist the
        // new one BEFORE using it and something goes wrong in between, the chain breaks
        // and the user has to sign in again.
        if let newRefresh = tok["refresh_token"] as? String {
            keychainSet(service: JIRA_OAUTH_KEYCHAIN, account: email, value: newRefresh)
        }
        jiraAccessToken = access
        jiraAccessExpiry = Date().addingTimeInterval(TimeInterval((tok["expires_in"] as? Int) ?? 3600))
        return .ok(access)
    }

    func authModeIsOAuth() -> Bool {
        guard let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
              let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
        else { return false }
        return (cfg["authMode"] as? String) == "oauth"
    }

    func authState(_ d: Data) -> String? {
        guard let j = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return nil }
        return j["jiraAuthState"]
    }

    /// Reads the tokens from the keychain and builds the JSON handed to fetch.mjs.
    ///
    /// The APP does the reading, not a `security` subprocess: because the app that
    /// wrote the entry is the one reading it, macOS asks for no permission. `security`
    /// is a separate binary, so reading through it popped a dialog.
    func tokenPayload() -> Data {
        var out: [String: String] = [:]
        dbg("tokenPayload called")
        if let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
           let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
           // ONLY entries written by the setup screen. If the app tries to read an older
           // entry created by hand with `security`, macOS opens a permission dialog
           // (this happened); in that case we do not touch the keychain at all and
           // fetch.mjs falls back to the old `security` path.
           cfg["tokensOwnedByApp"] as? Bool == true,
           let email = cfg["email"] as? String, !email.isEmpty {
            if (cfg["authMode"] as? String) == "oauth" {
                // If it has expired it is renewed silently here; no browser opens.
                switch currentJiraAccessToken(email: email) {
                case .ok(let at):   out["jiraAccessToken"] = at
                case .needsLogin:   out["jiraAuthState"] = "needsLogin"
                case .temporary:    out["jiraAuthState"] = "temporary"
                }
            } else {
                let jiraSvc = (cfg["keychainService"] as? String) ?? JIRA_KEYCHAIN
                if let t = keychainGet(service: jiraSvc, account: email) { out["jiraToken"] = t }
            }
            let ghSvc = (cfg["githubKeychainService"] as? String) ?? "sprint-board-github"
            if let g = keychainGet(service: ghSvc, account: email) { out["githubToken"] = g }
        }
        // We report the version ONLY in a distribution build. A development build
        // carries `appdir` in the bundle; there, saying "a new version is
        // available" on every refresh would just be noise.
        if Bundle.main.url(forResource: "appdir", withExtension: nil) == nil,
           let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            out["appVersion"] = v
        }
        return (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8)
    }

    /// Runs fetch.mjs in the background and hands its JSON to the web side.
    /// When the session is no longer valid (refresh token expired or revoked) this
    /// returns the user to the setup screen — all they need to do is sign in again.
    func requireLogin(_ reason: String) {
        DispatchQueue.main.async {
            guard !self.onSetupScreen else { return }
            self.onSetupScreen = true
            self.pendingSetupError = reason
            self.loadPage("setup.html")
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
        }
    }

    func reload() {
        if onSetupScreen { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            guard let node = NODE else {
                self.push(#"{"ok":false,"error":"node not found — looked in /opt/homebrew/bin, /usr/local/bin and /usr/bin"}"#)
                return
            }
            // Build the payload BEFORE STARTING the child process. In OAuth mode this
            // can make a network request (a token refresh); if it were built after,
            // fetch.mjs would read the empty pipe and carry on without a token.
            let payload = self.tokenPayload()
            // Go back to sign-in only if the session is REALLY dead. DO NOT on a
            // network error: throwing the user to the sign-in screen while the
            // internet is down means destroying a valid session (this happened).
            // In that case the normal flow below runs and the existing
            // "could not refresh" notice takes over.
            if self.authState(payload) == "needsLogin" {
                self.requireLogin("Your Atlassian session has ended — please sign in again.")
                return
            }

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
                self.push(#"{"ok":false,"error":"could not run fetch.mjs: \#(error)"}"#)
                return
            }
            // Tokens go to stdin, NOT argv: argv would show up in `ps` output.
            // If the child already died the write returns EPIPE; since SIGPIPE is
            // ignored the process survives and we swallow the error here.
            let handle = inPipe.fileHandleForWriting
            do { try handle.write(contentsOf: payload) } catch { }
            try? handle.close()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            let out = String(data: data, encoding: .utf8) ?? ""
            dbg("fetch output (\(out.count) bytes): \(out.prefix(240))")
            self.push(out.isEmpty ? #"{"ok":false,"error":"fetch.mjs produced no output"}"# : out)
        }
    }

    /// Retries a failed refresh without waiting the full 30 minutes.
    /// A single network blip (wifi not up yet right after waking, say) used to leave
    /// the widget on an error screen for half an hour.
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
            // escaped: ["<json text>"] -> we take [0] back out and parse it.
            // Errors are NOT swallowed: with completionHandler nil the page got stuck
            // on "loading" leaving no trace whatsoever. Now it reaches the log.
            self.web.evaluateJavaScript("window.sbRender(JSON.parse(\(escaped)[0]))") { _, err in
                if let err { NSLog("SB: sbRender hatasi: \(err.localizedDescription)") }
            }
        }
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        if let msg = pendingSetupError {
            pendingSetupError = nil
            let json = (try? JSONSerialization.data(withJSONObject: ["errors": [msg]]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            w.evaluateJavaScript("window.sbSetupResult && window.sbSetupResult(\(json))")
        }
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

    // MARK: notes (in a file; localStorage is unreliable on a file:// origin)

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

    // MARK: web -> swift bridge

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
        if let t = body["noteAdd"] as? String { addNote(t) }
        if let i = body["noteDel"] as? String { removeNote(i) }
        if let h = body["height"] as? Double, h > 60 {
            var f = window.frame
            let top = f.maxY                    // pin the top edge, grow downwards
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
app.setActivationPolicy(.accessory)   // no Dock icon
app.run()
