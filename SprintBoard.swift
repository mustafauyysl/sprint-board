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
import UserNotifications

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
        return !keychainHas(service: JIRA_OAUTH_KEYCHAIN, account: email)
    }
    let service = (cfg["keychainService"] as? String) ?? JIRA_KEYCHAIN
    return !keychainHas(service: service, account: email)
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

/// Whether the item exists, without reading the secret. macOS asks the user for permission
/// when an app reads the secret (unless they chose "Always Allow"); this check does not
/// read it, so asking "is anyone signed in?" never shows that dialog.
func keychainHas(service: String, account: String) -> Bool {
    SecItemCopyMatching([
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ] as CFDictionary, nil) == errSecSuccess
}

/// The Jira Cloud host a typed site names, or nil. Basic auth sends the token itself, so it
/// only ever goes to an *.atlassian.net host. Only host characters are allowed: a suffix
/// check alone let "other.example?.atlassian.net" send the request to other.example.
func jiraCloudHost(_ raw: String) -> String? {
    var site = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    for scheme in ["https://", "http://"] where site.hasPrefix(scheme) { site.removeFirst(scheme.count) }
    while site.hasSuffix("/") { site.removeLast() }
    let hostCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
    guard site.unicodeScalars.allSatisfy({ hostCharacters.contains($0) }),
          site.hasSuffix(".atlassian.net"), site.count > ".atlassian.net".count,
          !site.hasPrefix("."), !site.contains("..") else { return nil }
    return site
}

/// The keychain service holding a Jira API token this app wrote, or nil. Only a setup
/// screen sets `tokensOwnedByApp`. sprint-board-jira-token is only ever written by the
/// token sign-in, so it is the app's in any mode. Any other name is the app's only in token
/// mode (the first version wrote sprint-board-jira); under OAuth it can still name an older
/// hand-made entry, so it is left alone there.
func appWrittenTokenService(_ cfg: [String: Any]) -> String? {
    guard cfg["tokensOwnedByApp"] as? Bool == true else { return nil }
    let service = (cfg["keychainService"] as? String) ?? JIRA_KEYCHAIN
    if service == JIRA_TOKEN_KEYCHAIN { return service }
    return (cfg["authMode"] as? String) == "oauth" ? nil : service
}

/// The GitHub organization a typed name gives: "" for none (all PRs), nil when it is not a
/// valid GitHub login. The name goes into a search query, so nothing else is let through.
func githubOrgName(_ raw: String) -> String? {
    let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty { return "" }
    guard name.count <= 39,
          name.range(of: "^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$", options: .regularExpression) != nil else { return nil }
    return name
}

/// The Disconnect hint for how this Mac signed in. Disconnect only deletes keychain entries the
/// app wrote itself, so an entry made by hand is left alone and the hint says so.
func disconnectHint(_ cfg: [String: Any]) -> [String: String] {
    guard cfg["tokensOwnedByApp"] as? Bool == true else {
        return ["text": "This token was saved in the keychain by hand, so Disconnect deletes nothing from the keychain. It only signs this board out."]
    }
    if (cfg["authMode"] as? String) == "oauth" {
        return [
            "text": "Disconnect removes the sign-in from this Mac. Sprint Board keeps its access to your Atlassian account until you remove it under Connected apps at",
            "link": "id.atlassian.com",
            "url": "https://id.atlassian.com/manage-profile/apps",
        ]
    }
    return [
        "text": "Disconnect removes the token from this Mac. The token itself stays valid until you revoke it at",
        "link": "id.atlassian.com",
        "url": "https://id.atlassian.com/manage-profile/security/api-tokens",
    ]
}

/// What the setup screen gets when it opens from Settings or the gear button. nil while nobody is signed in
/// (first run, after Disconnect): the sign-in block then stays. Otherwise the screen shows the
/// account, the board settings and the Disconnect hint, and hides the sign-in block.
func setupContext(_ cfg: [String: Any]) -> [String: Any]? {
    guard let email = cfg["email"] as? String, !email.isEmpty else { return nil }
    return [
        "email": email,
        "mode": (cfg["authMode"] as? String) == "oauth" ? "oauth" : "token",
        "githubOrg": (cfg["githubOrg"] as? String) ?? "",
        "showDraftPrs": (cfg["showDraftPrs"] as? Bool) ?? true,
        "sprintGoalTracking": (cfg["sprintGoalTracking"] as? Bool) ?? false,
        "partnerDomainSuffixes": partnerDomainSuffixes(cfg),
        "hint": disconnectHint(cfg),
    ]
}

/// The notifications a fetch result asks for. New conflicts always notify, even while the
/// setup screen is open: fetch.mjs has already remembered them, so a dropped one is lost
/// for good. The summary answers a refresh the user asked for; the setup screen cancels it.
func resultNotifications(_ obj: [String: Any]?, ok: Bool, manual: Bool, onSetupScreen: Bool) -> [[String: String]] {
    var out: [[String: String]] = []
    for n in (obj?["notify"] as? [[String: Any]]) ?? [] {
        guard let id = n["id"] as? String, let title = n["title"] as? String else { continue }
        var note = ["id": id, "title": title, "body": (n["body"] as? String) ?? ""]
        if let url = n["url"] as? String { note["url"] = url }
        out.append(note)
    }
    guard manual, !onSetupScreen else { return out }
    if ok, let s = obj?["summary"] as? [String: Any], let title = s["title"] as? String {
        out.append(["id": "refresh", "title": title, "body": (s["body"] as? String) ?? ""])
    } else if !ok {
        out.append(["id": "refresh", "title": "Refresh failed", "body": (obj?["error"] as? String) ?? "unknown error"])
    }
    return out
}

func keychainDelete(service: String, account: String) {
    SecItemDelete([
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ] as CFDictionary)
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
let SHOW_IN_DOCK_KEY = "showInDock"

/// Whether the app shows in the Dock (and so in Cmd+Tab). A desktop widget stays out of
/// both unless the user opts in from the menu bar; LSUIElement in Info.plist says the same.
func dockChoice(_ stored: Any?) -> Bool {
    (stored as? Bool) ?? false
}

/// The choice after one click on "Show in Dock".
func toggledDockChoice(_ stored: Any?) -> Bool {
    !dockChoice(stored)
}
/// An API token entered on the setup screen. A separate service from JIRA_KEYCHAIN so it
/// never collides with an entry made by hand with `security`, which this app cannot
/// read without a permission dialog.
let JIRA_TOKEN_KEYCHAIN = "sprint-board-jira-token"

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
                <!doctype html><meta charset="utf-8"><title>Sprint Board</title>
                <body style="color-scheme:light dark;font:15px -apple-system,system-ui,sans-serif;
                             background:Canvas;color:CanvasText;
                             display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
                <div style="text-align:center">
                  <h2 style="font-size:20px;font-weight:600;margin:0 0 6px">Sprint Board</h2>
                  <p style="margin:0;opacity:.6">Signed in. You can close this tab.</p>
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

// --- /etc/hosts ------------------------------------------------------------
// The Hosts tab switches domains between local (127.0.0.1) and prod (real DNS), one by one
// or a filtered group at a time, like the retired Tempest tool. Sprint Board owns ONE marked
// block in /etc/hosts and never edits a line outside it: a domain is local while its line is
// in the block. The file is the source of truth for that, so a hand edit is never overridden
// by remembered state; the saved list only holds the domains and the user's groups.
let HOSTS_PATH = "/etc/hosts"
let HOSTS_BLOCK_START = "# >>> extension manages >>>"
let HOSTS_BLOCK_END = "# <<< extension manages <<<"
/// The markers before the rename. A block under them is still the managed block (one under each
/// kind of marker is a damaged file); the next write puts it back in place under the markers above.
let HOSTS_LEGACY_BLOCK_START = "# >>> sprint-board hosts managed >>>"
let HOSTS_LEGACY_BLOCK_END = "# <<< sprint-board hosts managed <<<"
/// The domain list, which survives Prod mode. Not config.json: fetch.mjs rewrites that file.
let HOSTS_LIST_PATH = ("~/.config/sprint-widget/hosts.json" as NSString).expandingTildeInPath
let HOSTS_BACKUP_DIR = ("~/.local/state/sprint-widget" as NSString).expandingTildeInPath

/// A domain typed by the user, normalised (lower case; scheme, path, port and a trailing dot
/// dropped), or nil when it is not a hostname. Only names that pass this reach /etc/hosts,
/// so typed text can never add a line of its own (a newline, a second address).
func hostsName(_ raw: String) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
    if let i = s.firstIndex(where: { "/?#".contains($0) }) { s = String(s[..<i]) }
    if let i = s.lastIndex(of: ":"), s[s.index(after: i)...].allSatisfy({ $0.isASCII && $0.isNumber }) {
        s = String(s[..<i])
    }
    if s.hasSuffix(".") { s.removeLast() }
    let labels = s.split(separator: ".", omittingEmptySubsequences: false)
    let valid = s.count <= 253 && labels.count >= 2
        && labels.allSatisfy { label in
            (1...63).contains(label.count) && label.first != "-" && label.last != "-"
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
        && !labels[labels.count - 1].allSatisfy(\.isNumber)
    return valid ? s : nil
}

/// An active /etc/hosts line as its address and names; nil for comments and blank lines.
func hostsEntry(_ line: String) -> (address: String, names: [String])? {
    let active = line.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    let fields = active.split(whereSeparator: \.isWhitespace).map { $0.lowercased() }
    return fields.count >= 2 ? (fields[0], Array(fields.dropFirst())) : nil
}

/// Line indices of Sprint Board's block markers, the current ones or the ones before the rename.
func hostsMarkers(_ lines: [String]) -> (starts: [Int], ends: [Int]) {
    let trimmed = lines.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    let starts: Set = [HOSTS_BLOCK_START, HOSTS_LEGACY_BLOCK_START], ends: Set = [HOSTS_BLOCK_END, HOSTS_LEGACY_BLOCK_END]
    return (trimmed.indices.filter { starts.contains(trimmed[$0]) },
            trimmed.indices.filter { ends.contains(trimmed[$0]) })
}

/// The block's line range, nil when there is none. Only meaningful when the block is not
/// damaged (managedHosts != nil).
func hostsBlockRange(_ lines: [String]) -> ClosedRange<Int>? {
    let m = hostsMarkers(lines)
    guard let start = m.starts.first, let end = m.ends.first, start < end else { return nil }
    return start...end
}

/// The domains in Sprint Board's block ([] when there is no block), or nil when the block
/// is damaged — a marker missing, repeated or out of order. A damaged file is never written.
func managedHosts(_ text: String) -> [String]? {
    let lines = text.components(separatedBy: "\n")
    let m = hostsMarkers(lines)
    if m.starts.isEmpty && m.ends.isEmpty { return [] }
    guard m.starts.count == 1, m.ends.count == 1, m.starts[0] < m.ends[0] else { return nil }
    return lines[(m.starts[0] + 1)..<m.ends[0]].flatMap { hostsEntry($0)?.names ?? [] }
}

/// The file with Sprint Board's block set to `names` — replaced where it is, else appended
/// at the end; no names (Prod) means no block. Every other byte stays as it was. The names
/// are validated again here, at the last step before the file. nil when the block is damaged.
func hostsWithBlock(_ text: String, _ names: [String]) -> String? {
    guard managedHosts(text) != nil else { return nil }
    var seen = Set<String>()
    let clean = names.compactMap(hostsName).filter { seen.insert($0).inserted }
    let block = clean.isEmpty ? [] : [HOSTS_BLOCK_START] + clean.map { "127.0.0.1\t\($0)" } + [HOSTS_BLOCK_END]
    var lines = text.components(separatedBy: "\n")
    if let range = hostsBlockRange(lines) {
        lines.replaceSubrange(range, with: block)
    } else if !block.isEmpty {
        // Appended after the last line, keeping the file's final newline if it had one, so
        // removing the block later gives back exactly the original bytes.
        let finalNewline = lines.last == ""
        if finalNewline { lines.removeLast() }
        lines += block + (finalNewline ? [""] : [])
    }
    return lines.joined(separator: "\n")
}

/// Active lines OUTSIDE the block that map a listed domain, to any address. Those domains stay
/// pinned there even in Prod; Sprint Board does not touch them, it can only point them out.
/// One entry per line: the 1-based line number, its address and the listed names on it.
func hostsConflicts(_ text: String, _ names: [String]) -> [[String: Any]] {
    let lines = text.components(separatedBy: "\n")
    guard managedHosts(text) != nil else { return [] }
    let block = hostsBlockRange(lines)
    let listed = Set(names)
    return lines.indices.compactMap { i -> [String: Any]? in
        guard block?.contains(i) != true, let entry = hostsEntry(lines[i]) else { return nil }
        let hits = entry.names.filter { listed.contains($0) }
        return hits.isEmpty ? nil : ["line": i + 1, "address": entry.address, "names": hits]
    }
}

/// Valid names on active 127.0.0.1 / ::1 lines outside the block that are not listed yet, in
/// file order: the hand-kept local entries the list can take over.
func hostsImportable(_ text: String, _ known: [String]) -> [String] {
    let lines = text.components(separatedBy: "\n")
    guard managedHosts(text) != nil else { return [] }
    let block = hostsBlockRange(lines)
    var seen = Set(known)
    return lines.indices.flatMap { i -> [String] in
        guard block?.contains(i) != true, let entry = hostsEntry(lines[i]),
              entry.address == "127.0.0.1" || entry.address == "::1" else { return [] }
        return entry.names.compactMap(hostsName).filter { seen.insert($0).inserted }
    }
}

/// The group a "# Group - XYZ" line names ("group" in any case, spaces optional), or nil for any
/// other line or a name hostsGroupName refuses.
func hostsGroupHeader(_ line: String) -> String? {
    var s = Substring(line.trimmingCharacters(in: .whitespaces))
    guard s.hasPrefix("#") else { return nil }
    s = s.drop(while: { $0 == "#" }).drop(while: { $0 == " " || $0 == "\t" })
    guard s.lowercased().hasPrefix("group") else { return nil }
    s = s.dropFirst(5).drop(while: { $0 == " " || $0 == "\t" })
    guard s.hasPrefix("-") else { return nil }
    return hostsGroupName(String(s.dropFirst()))
}

/// The groups "# Group - XYZ" headers give the lines below them, up to the next line that starts
/// with "#": each name on an active 127.0.0.1 / ::1 line outside the block, with its header's
/// group. A name keeps the first header that claims it. Used when importing hand-kept entries.
func hostsImportGroups(_ text: String) -> [String: String] {
    let lines = text.components(separatedBy: "\n")
    guard managedHosts(text) != nil else { return [:] }
    let block = hostsBlockRange(lines)
    var current: String?
    var groups: [String: String] = [:]
    for i in lines.indices {
        if block?.contains(i) == true { current = nil; continue }
        if lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("#") { current = hostsGroupHeader(lines[i]); continue }
        guard let g = current, let entry = hostsEntry(lines[i]),
              entry.address == "127.0.0.1" || entry.address == "::1" else { continue }
        for name in entry.names.compactMap(hostsName) where groups[name] == nil { groups[name] = g }
    }
    return groups
}

struct HostsGroup: Equatable {
    var name: String
    var domains: [String]
}

/// The Hosts tab's saved list: every known domain in order, and the user's named groups,
/// which only name subsets of `domains` (a domain may be in several). Whether a domain is
/// local is not stored here: it is read from /etc/hosts.
struct HostsList: Equatable {
    var domains: [String] = []
    var groups: [HostsGroup] = []
}

/// The domains a partner's local environment answers on are `<partner>.<suffix>`, one for each
/// suffix in the config's `partnerDomainSuffixes`; "Add partner" adds them together. Without
/// any, the Hosts tab has no "Add partner" and no domain counts as a partner's.
func partnerDomainSuffixes(_ config: [String: Any]) -> [String] {
    var seen = Set<String>()
    return (config["partnerDomainSuffixes"] as? [String] ?? []).compactMap(hostsName).filter { seen.insert($0).inserted }
}
/// The partner domain suffixes a typed, comma-separated list gives: [] for none, nil when an
/// entry is not a domain name.
func partnerSuffixList(_ raw: String) -> [String]? {
    let entries = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    let names = entries.map(hostsName)
    guard !names.contains(where: { $0 == nil }) else { return nil }
    var seen = Set<String>()
    return names.compactMap { $0 }.filter { seen.insert($0).inserted }
}
/// The group every partner domain goes into, whichever way it was added; made when missing.
let PARTNERS_GROUP = "Partners"

/// A partner's panel name as typed (a pasted partner domain or URL gives its first label), or
/// nil when it cannot start a host name: letters, digits and inner hyphens, at most 60 characters.
func hostsPartnerName(_ raw: String) -> String? {
    let host = hostsName(raw) ?? raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let first = host.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    guard (1...60).contains(first.count), first.first != "-", first.last != "-",
          first.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
    return first
}

/// A group name as typed: trimmed, 1–40 characters, one line.
func hostsGroupName(_ raw: String) -> String? {
    let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...40).contains(name.count), !name.contains(where: { $0.isNewline || $0 == "\t" }) else { return nil }
    return name
}

/// The list from hosts.json; nil when the file's shape is wrong anywhere — a group of the wrong
/// type is not dropped quietly, or the next save would lose it for good. A file from before
/// groups ({"domains": [...]} only) reads as a list with no groups. Invalid or repeated values
/// are dropped, and a group can only name domains that are in the list.
func hostsList(fromJSON object: Any?) -> HostsList? {
    guard let json = object as? [String: Any], let raw = json["domains"] as? [String] else { return nil }
    let rawGroups = json["groups"] ?? [[String: Any]]()
    guard let groupObjects = rawGroups as? [[String: Any]],
          groupObjects.allSatisfy({ $0["name"] is String && ($0["domains"] == nil || $0["domains"] is [String]) })
    else { return nil }
    var seen = Set<String>()
    let domains = raw.compactMap(hostsName).filter { seen.insert($0).inserted }
    var names = Set<String>()
    let groups = groupObjects.compactMap { g -> HostsGroup? in
        guard let name = (g["name"] as? String).flatMap(hostsGroupName), names.insert(name.lowercased()).inserted
        else { return nil }
        var members = Set<String>()
        let listed = (g["domains"] as? [String] ?? []).compactMap(hostsName)
            .filter { seen.contains($0) && members.insert($0).inserted }
        return HostsGroup(name: name, domains: listed)
    }
    return HostsList(domains: domains, groups: groups)
}

func hostsListJSON(_ list: HostsList) -> [String: Any] {
    ["domains": list.domains, "groups": list.groups.map { ["name": $0.name, "domains": $0.domains] }]
}

/// One Hosts tab action applied to the saved list and to the local domains (the block's
/// names). Returns both — `local` in list order, ready for hostsWithBlock — and an error for
/// the user. Pure: the caller reads and writes the files. Actions: add (+ group), addMany
/// (+ group), addPartner (+ group), remove, setMode + names, groupAdd (+ domain), groupRename
/// {from, to}, groupDelete, groupDeleteWithDomains, member {domain, group, on}. Group names
/// match without regard to case. `partners` are the partner domain suffixes.
func hostsApply(_ list: HostsList, local: [String], _ action: [String: Any], partners: [String])
    -> (list: HostsList, local: [String], error: String?) {
    var list = list
    var localSet = Set(local)
    var error: String?
    // Names in the block that the list does not know (added by hand, or written before the
    // list existed) are adopted, so everything that is local shows up in the tab.
    // Only names the list itself would accept: anything else could not be saved and read back.
    for name in local where hostsName(name) == name && !list.domains.contains(name) { list.domains.append(name) }

    func group(_ name: Any?) -> Int? {
        guard let name = name as? String else { return nil }
        return list.groups.firstIndex { $0.name.lowercased() == name.lowercased() }
    }
    func join(_ domain: String, _ g: Int?) {
        guard let g, list.domains.contains(domain), !list.groups[g].domains.contains(domain) else { return }
        list.groups[g].domains.append(domain)
    }
    // Made when missing, found without regard to case.
    func ensureGroup(_ name: String) -> Int? {
        if group(name) == nil { list.groups.append(HostsGroup(name: name, domains: [])) }
        return group(name)
    }
    // A partner's domain (<partner>.<suffix>, the partner one label) also joins the Partners group.
    func joinPartners(_ name: String) {
        guard let partner = partners.lazy
            .compactMap({ name.hasSuffix(".\($0)") ? String(name.dropLast($0.count + 1)) : nil }).first,
              hostsPartnerName(partner) == partner else { return }
        join(name, ensureGroup(PARTNERS_GROUP))
    }
    func addDomain(_ name: String, into g: Int?) {
        if !list.domains.contains(name) { list.domains.append(name) }   // a new domain starts in prod
        joinPartners(name)
        join(name, g)
    }

    if let raw = action["add"] as? String {
        if let name = hostsName(raw) {
            addDomain(name, into: group(action["group"]))
        } else {
            error = "“\(raw.trimmingCharacters(in: .whitespacesAndNewlines))” is not a domain name."
        }
    }
    if let many = action["addMany"] as? [String] {
        let headed = action["addManyGroups"] as? [String: String] ?? [:]
        for name in many.compactMap(hostsName) {
            let isNew = !list.domains.contains(name)
            addDomain(name, into: group(action["group"]))
            // A "# Group - XYZ" header above its line names its group; only a name new to the list.
            if isNew, let g = headed[name].flatMap(hostsGroupName) { join(name, ensureGroup(g)) }
        }
    }
    if let raw = action["addPartner"] as? String {
        if partners.isEmpty {
            error = "Adding a partner needs its domain suffixes: partnerDomainSuffixes in the config."
        } else if let partner = hostsPartnerName(raw) {
            // addDomain puts each of them in the Partners group.
            for name in partners.compactMap({ hostsName("\(partner).\($0)") }) {
                addDomain(name, into: group(action["group"]))
            }
        } else {
            error = "“\(raw.trimmingCharacters(in: .whitespacesAndNewlines))” is not a partner name: up to 60 letters, digits and hyphens, as in the panel."
        }
    }
    if let name = action["remove"] as? String {
        list.domains.removeAll { $0 == name }
        for g in list.groups.indices { list.groups[g].domains.removeAll { $0 == name } }
        localSet.remove(name)
    }
    if let mode = action["setMode"] as? String, let names = action["names"] as? [String] {
        let known = names.filter { list.domains.contains($0) }
        if mode == "local" { localSet.formUnion(known) } else if mode == "prod" { localSet.subtract(known) }
    }
    if let raw = action["groupAdd"] as? String {
        if let name = hostsGroupName(raw) {
            let domain = action["domain"] as? String
            if group(name) == nil {
                list.groups.append(HostsGroup(name: name, domains: []))
            } else if domain == nil {
                error = "There is already a group called “\(name)”."
            }
            if let domain { join(domain, group(name)) }   // "New group…" from a domain's menu
        } else {
            error = "A group name needs 1 to 40 characters on one line."
        }
    }
    if let rename = action["groupRename"] as? [String: Any], let from = group(rename["from"]) {
        if let to = (rename["to"] as? String).flatMap(hostsGroupName) {
            if let other = group(to), other != from {
                error = "There is already a group called “\(to)”."
            } else {
                list.groups[from].name = to
            }
        } else {
            error = "A group name needs 1 to 40 characters on one line."
        }
    }
    if let g = group(action["groupDelete"]) {
        list.groups.remove(at: g)   // its domains stay in the list
    }
    if let g = group(action["groupDeleteWithDomains"]) {
        // A partner (or any group) removed as one piece: its domains leave the list, every
        // other group and the block.
        let doomed = Set(list.groups[g].domains)
        list.groups.remove(at: g)
        list.domains.removeAll { doomed.contains($0) }
        for i in list.groups.indices { list.groups[i].domains.removeAll { doomed.contains($0) } }
        localSet.subtract(doomed)
    }
    if let member = action["member"] as? [String: Any], let domain = member["domain"] as? String,
       let g = group(member["group"]) {
        if member["on"] as? Bool == true {
            join(domain, g)
        } else {
            list.groups[g].domains.removeAll { $0 == domain }
        }
    }
    return (list, list.domains.filter { localSet.contains($0) }, error)
}

/// What the Hosts tab shows: every domain with its state read from the file and its groups,
/// the group names, and what needs attention.
func hostsStatus(_ text: String, _ list: HostsList, writable: Bool) -> [String: Any] {
    let block = managedHosts(text)
    let local = Set(block ?? [])
    let domains: [[String: Any]] = list.domains.map { name in
        ["name": name, "local": local.contains(name),
         "groups": list.groups.filter { $0.domains.contains(name) }.map(\.name)]
    }
    guard let block else {
        return ["mode": "damaged", "domains": domains, "groups": list.groups.map(\.name), "conflicts": [],
                "importable": [], "writable": writable]
    }
    return [
        "mode": "ok",
        "domains": domains,
        "groups": list.groups.map(\.name),
        "conflicts": hostsConflicts(text, list.domains),
        "importable": hostsImportable(text, list.domains + block),
        "writable": writable,
    ]
}

/// The text of a hosts file, and whether it starts with a UTF-8 byte-order mark (some editors
/// write one; it is put back on write). nil when the bytes are not UTF-8: such a file is
/// neither shown as a mode nor written.
func hostsFileText(_ data: Data) -> (text: String, bom: Bool)? {
    let bom = data.starts(with: [0xEF, 0xBB, 0xBF])
    guard let text = String(data: bom ? data.dropFirst(3) : data, encoding: .utf8) else { return nil }
    return (text, bom)
}

/// Sets Sprint Board's block in the hosts file to `names`; returns an error for the user, or
/// nil on success. Writes IN PLACE: the user may write /etc/hosts (its owner here) but cannot
/// create files in /etc, so temp-file-and-rename is impossible — and writing in place keeps
/// the file's owner and mode exactly as they were. The previous contents go to `backupDir`
/// first: hosts.bak every time, hosts.before-sprint-board once.
func writeHostsBlock(_ names: [String], path: String, backupDir: String) -> String? {
    let fm = FileManager.default
    guard let data = fm.contents(atPath: path), let file = hostsFileText(data) else {
        return "Could not read \(path) as text; nothing was changed."
    }
    guard let next = hostsWithBlock(file.text, names) else {
        return "Sprint Board's block in \(path) is damaged (a marker line is missing or repeated). Fix it by hand; nothing was changed."
    }
    if next == file.text { return nil }
    guard fm.isWritableFile(atPath: path) else {
        return "\(path) is not writable by your user, so Sprint Board cannot change it."
    }
    // The backups are the file's exact bytes, not a re-encoding of its text.
    try? fm.createDirectory(atPath: backupDir, withIntermediateDirectories: true)
    let original = (backupDir as NSString).appendingPathComponent("hosts.before-sprint-board")
    if !fm.fileExists(atPath: original) { fm.createFile(atPath: original, contents: data) }
    let backup = (backupDir as NSString).appendingPathComponent("hosts.bak")
    guard (try? data.write(to: URL(fileURLWithPath: backup), options: .atomic)) != nil else {
        return "Could not back up \(path); nothing was changed."
    }
    let out = (file.bom ? Data([0xEF, 0xBB, 0xBF]) : Data()) + Data(next.utf8)
    // No .atomic option: written in place.
    guard (try? out.write(to: URL(fileURLWithPath: path))) != nil else {
        return "Could not write \(path) (the previous version is in \(backup))."
    }
    // Read it back: name lookups use what the file holds, not what we meant to write.
    guard fm.contents(atPath: path) == out else {
        return "\(path) did not keep the change; check it by hand (the previous version is in \(backup))."
    }
    return nil
}

/// How long a Chrome refresh may take before osascript is stopped.
let CHROME_REFRESH_TIMEOUT: TimeInterval = 20

/// AppleScript that makes Chrome drop its open connections and its DNS cache so its pages follow
/// a hosts switch: Chrome keeps sending a host to the connection it already has. It calls
/// chrome.benchmarking (present only when Chrome was started with --enable-net-benchmarking) in
/// a web tab that is already open, so nothing visible happens; once per window, incognito ones
/// too, because each profile has its own connections. The active tab goes first: it is always
/// loaded, while an inactive tab may be discarded and never answer. A window without a web tab,
/// or one closed meanwhile (-1728), is skipped. A failing window does not stop the others, and
/// the first failure is raised at the end. Chrome is never started for this.
func chromeRefreshScript() -> String {
    let flush = "(function(){if(!window.chrome||!chrome.benchmarking)return 'no-benchmarking';chrome.benchmarking.clearHostResolverCache();chrome.benchmarking.closeConnections();return 'ok';})()"
    return """
    if application id "com.google.Chrome" is not running then return
    tell application id "com.google.Chrome"
        set failure to missing value
        repeat with w in (every window)
            set windowFailure to missing value
            try
                set activeTab to active tab of w
                set candidates to {activeTab}
                repeat with t in (tabs of w)
                    if id of t is not (id of activeTab) then set end of candidates to (contents of t)
                end repeat
                repeat with t in candidates
                    if (URL of t) starts with "http" then
                        try
                            with timeout of 3 seconds
                                set outcome to execute t javascript "\(flush)"
                            end timeout
                            if outcome is "ok" then
                                set windowFailure to missing value
                                exit repeat
                            end if
                            if outcome is "no-benchmarking" then
                                set windowFailure to {"Chrome was not started with --enable-net-benchmarking", 9101}
                                exit repeat
                            end if
                            set windowFailure to {"Chrome answered " & (outcome as text), 9102}
                        on error errText number errNumber
                            if errNumber is not -1728 then set windowFailure to {errText, errNumber}
                            if errNumber is 12 then exit repeat
                        end try
                    end if
                end repeat
            on error errText number errNumber
                if errNumber is not -1728 then set windowFailure to {errText, errNumber}
            end try
            if windowFailure is not missing value and failure is missing value then set failure to windowFailure
        end repeat
        if failure is not missing value then error (item 1 of failure) number (item 2 of failure)
    end tell
    """
}

/// What the Hosts tab says after a Chrome refresh, from osascript's exit and its error output
/// ("…execution error: <message> (<number>)"); nil when there is nothing to say: success, or
/// Chrome quit in between. Anything unrecognised keeps its own text, so no failure is hidden.
func chromeRefreshNote(status: Int32, stderr: String, timedOut: Bool) -> String? {
    if timedOut { return "Chrome did not answer, so its pages may keep the old address until reloaded." }
    guard status != 0 else { return nil }
    let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
    var message = text
    var code: Int?
    if text.hasSuffix(")"), let open = text.range(of: " (", options: .backwards),
       let n = Int(text[open.upperBound..<text.index(before: text.endIndex)]) {
        code = n
        message = String(text[..<open.lowerBound])
    }
    if let r = message.range(of: "execution error: ") { message = String(message[r.upperBound...]) }
    let prefix = "Google Chrome got an error: "
    if message.hasPrefix(prefix) { message = String(message.dropFirst(prefix.count)) }
    switch code {
    case .some(12) where message.contains("AppleScript is turned off"):
        return "Chrome kept its old connections: in that window's profile turn on View › Developer › Allow JavaScript from Apple Events."
    case .some(9101) where message.contains("--enable-net-benchmarking"):
        return "Chrome kept its old connections: quit it (⌘Q) and open it with the Chrome button above."
    case .some(-1743):
        return "macOS did not let Sprint Board refresh Chrome: allow it in System Settings › Privacy & Security › Automation."
    case .some(-600), .some(-609):
        return nil
    default:
        return message.isEmpty ? "Could not refresh Chrome (osascript exited with \(status))." : "Could not refresh Chrome: \(message)"
    }
}

/// The flags the Hosts tab's Chrome button starts Chrome with: local sites with self-signed
/// certificates open, and chrome.benchmarking exists for chromeRefreshScript.
let CHROME_INSECURE_FLAGS = ["--ignore-certificate-errors", "--allow-insecure-localhost", "--enable-net-benchmarking"]

/// The CHROME_INSECURE_FLAGS a running Chrome's command line (as `ps` prints it) lacks; each
/// flag must appear as a whole word.
func chromeMissingFlags(_ commandLine: String) -> [String] {
    let words = Set(commandLine.split(whereSeparator: \.isWhitespace).map(String.init))
    return CHROME_INSECURE_FLAGS.filter { !words.contains($0) }
}

let APP_DIR = resolveAppDir()
let NODE = resolveNode()
/// Cloudflare WARP intercepts TLS, and because Node does not read the macOS
/// keychain every fetch fails with "fetch failed" without WARP's root certificate.
let WARP_CA = "/usr/local/etc/cloudflare-zt/allCAbundle.pem"
let REFRESH_SECONDS: TimeInterval = 30 * 60
let NOTES_PATH = ("~/.local/state/sprint-widget/notes.json" as NSString).expandingTildeInPath
let MAX_NOTES = 6
let NOTE_LIMIT = 500
/// The corner radius of the board card in view.html and setup.html; the window material follows it.
let CARD_RADIUS: CGFloat = 10

/// `frame` moved, and shortened if needed, to lie inside the visible area of its own screen: the
/// screen `current` overlaps most (the main screen when it is on none, e.g. a display was unplugged).
/// Pass the window's frame before a resize, so a tall board cannot pick the screen below.
func onScreen(_ frame: NSRect, near current: NSRect? = nil) -> NSRect {
    let at = current ?? frame
    let area = { (s: NSScreen) in s.frame.intersection(at).width * s.frame.intersection(at).height }
    guard let screen = NSScreen.screens.filter({ area($0) > 0 }).max(by: { area($0) < area($1) })
            ?? NSScreen.main else { return frame }
    let vf = screen.visibleFrame
    var f = frame
    f.size.height = min(f.height, vf.height)
    f.size.width = min(f.width, vf.width)
    f.origin.x = min(max(f.minX, vf.minX), vf.maxX - f.width)
    f.origin.y = min(max(f.minY, vf.minY), vf.maxY - f.height)
    return f
}

/// A stretchable mask that rounds the popover material's corners to `radius`.
func roundedMask(_ radius: CGFloat) -> NSImage {
    let side = radius * 2 + 1
    let mask = NSImage(size: NSSize(width: side, height: side), flipped: false) { r in
        NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill()
        return true
    }
    mask.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    mask.resizingMode = .stretch
    return mask
}

/// The SF Symbols the page uses. A page cannot load them itself, so each one goes in as a
/// CSS mask image on `.s-<name>` (dots become dashes) and takes the text colour.
let PAGE_SYMBOLS = [
    "arrow.clockwise", "gearshape", "flag.fill", "checkmark.seal.fill", "exclamationmark.triangle.fill",
    "checkmark.circle.fill", "xmark.circle", "xmark.circle.fill", "xmark.octagon.fill", "shippingbox",
    "shippingbox.fill", "flame.fill", "arrow.uturn.forward.circle", "arrow.uturn.forward", "circle",
    "circle.lefthalf.filled", "testtube.2", "arrow.triangle.pull", "checkmark", "xmark", "clock", "eye",
    "hourglass", "ellipsis.circle", "info.circle", "arrow.down.circle", "chevron.down", "chevron.up", "chevron.left", "globe", "arrow.triangle.merge", "checklist",
]

func symbolStyleSheet() -> String {
    var css = ""
    for name in PAGE_SYMBOLS {
        guard let img = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 40, weight: .regular)),
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(img.size.width * 2),
                                         pixelsHigh: Int(img.size.height * 2), bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            dbg("symbol not found: \(name)")
            continue
        }
        rep.size = img.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        img.draw(in: NSRect(origin: .zero, size: img.size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { continue }
        css += ".s-\(name.replacingOccurrences(of: ".", with: "-")){-webkit-mask-image:url(data:image/png;base64,\(png.base64EncodedString()))}\n"
    }
    return css
}

/// A script that adds `symbolStyleSheet()` to a page once it has loaded.
func symbolScript() -> WKUserScript? {
    guard let css = try? JSONSerialization.data(withJSONObject: symbolStyleSheet(), options: .fragmentsAllowed),
          let literal = String(data: css, encoding: .utf8) else { return nil }
    let js = "(() => { const s = document.createElement('style'); s.textContent = \(literal); document.head.appendChild(s); })()"
    return WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
}

/// The board's width, the same in the widget and in the menu bar panel.
let BOARD_WIDTH: CGFloat = 430
/// The panel's height until its page reports one.
let PANEL_START_HEIGHT: CGFloat = 420
/// The panel's tabs, in order: segment title, page, and the message handler that page posts
/// to. Each page reaches only its own handler, so the Hosts page cannot drive the board.
let PANEL_TABS: [(title: String, page: String, handler: String)] = [
    ("Sprint", "popover/sprints.html", "sb"),
    ("Hosts", "popover/hosts.html", "hosts"),
]
/// The page the widget shows as its board; the panel's Sprint tab shows the same page.
let WIDGET_BOARD_PAGE = "popover/sprints.html"
let WIDGET_TAB_KEY = "widgetTab"
/// The motion of a fold in popover/sprints.html (FOLD_MOTION), so the window edge moves with it.
let WIDGET_FIT_SECONDS: TimeInterval = 0.2
let WIDGET_FIT_CURVE = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
/// The tint of the widget's board, behind the tab header and the tab pages.
let WIDGET_TINT = NSColor(srgbRed: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 0.8)
/// Runs in the widget's tab pages. Swift calls sbFit after fill mode; these pages have no own one.
let WIDGET_PAGE_SCRIPT = #"""
addEventListener('DOMContentLoaded', () => {
  const card = document.getElementById('card');
  const handlers = window.webkit?.messageHandlers;
  if (!card || window.sbFit) return;
  window.sbFit = () => requestAnimationFrame(() => (handlers?.sb ?? handlers?.hosts)?.postMessage({ height: card.offsetHeight }));
});
"""#
/// Runs first in every panel page; see makePanelWebView.
let PANEL_PAGE_SCRIPT = """
document.documentElement.classList.add('nohover');
addEventListener('mousemove', (e) => {
  if (e.movementX || e.movementY) document.documentElement.classList.remove('nohover');
}, true);
"""
/// Height of the tab header above the pages.
let PANEL_HEADER_HEIGHT: CGFloat = 38
let PANEL_TAB_KEY = "panelTab"
/// What the panel's board shows while the widget waits on the setup screen (sign-in, or
/// macOS refusing the token) and there is no data yet: setup lives in the widget.
let SETUP_PENDING_RESULT = #"{"ok":false,"error":"Action needed: sign in or allow keychain access. Open Settings with the gear button."}"#

/// Dragging the top strip moves the window; everything else reaches the WebView
/// as a normal click. (CSS -webkit-app-region is Electron-specific and does
/// nothing in WKWebView — and isMovableByWindowBackground is not enough either,
/// because the WebView consumes the events.)
// Menu bar icon — not the drag class's job, it lives at the top level.
/// The sprint ring of the app icon for the menu bar: a faint track, a three-quarter
/// arc and a check. Being a template image it is drawn black (the track as alpha)
/// and macOS handles the tinting. Drawn paths, not an SF Symbol, so it matches the
/// app icon on every macOS version.
/// What the menu bar icon shows: the sprint's progress as the ring, and in it a check, an
/// exclamation mark when something needs you, or three dots before the first data. A failed
/// refresh fades the last state: what it shows is old.
struct MenuIconState: Equatable {
    var progress: Double? = nil
    var needsYou = false
    var stale = false
}

/// "Needs you" is a review waiting two days or more, or an own PR that cannot merge (conflict,
/// broken required check, changes requested). A PR GitHub is still checking and an overdue task
/// do not count: the popover shows them, and an icon that never leaves the alert says nothing.
func menuIconState(_ obj: [String: Any]?, ok: Bool, previous: MenuIconState) -> MenuIconState {
    guard ok, let obj else {
        var faded = previous
        faded.stale = true
        return faded
    }
    let done = (obj["done"] as? NSNumber)?.doubleValue ?? 0
    let total = (obj["total"] as? NSNumber)?.doubleValue ?? 0
    let reviews = obj["reviewRequests"] as? [[String: Any]] ?? []
    let blocked = obj["pullRequests"] as? [[String: Any]] ?? []
    let lateReview = reviews.contains { (($0["days"] as? NSNumber)?.intValue ?? 0) >= 2 }
    let cannotMerge = blocked.contains { ($0["kind"] as? String) != "checking" }
    let progress = total > 0 ? min(1, done / total) : 0
    return MenuIconState(progress: progress, needsYou: lateReview || cannotMerge, stale: false)
}

func ringIcon(_ side: CGFloat, _ state: MenuIconState = MenuIconState()) -> NSImage {
    let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            NSPoint(x: x * side, y: y * side)
        }
        let ink = NSColor.black.withAlphaComponent(state.stale ? 0.45 : 1)
        let center = p(0.5, 0.5), radius = side * 0.38
        let track = NSBezierPath()
        track.appendArc(withCenter: center, radius: radius, startAngle: 0, endAngle: 360)
        track.lineWidth = side * 0.11
        NSColor.black.withAlphaComponent(state.stale ? 0.14 : 0.3).setStroke()
        track.stroke()

        ink.setStroke()
        ink.setFill()
        if let progress = state.progress, progress > 0 {
            let arc = NSBezierPath()
            arc.appendArc(withCenter: center, radius: radius, startAngle: 90,
                          endAngle: 90 - 360 * CGFloat(min(progress, 0.999)), clockwise: true)
            arc.lineWidth = side * 0.11
            arc.lineCapStyle = .round
            arc.stroke()
        }
        if state.progress == nil {
            for x in [0.34, 0.5, 0.66] as [CGFloat] {
                NSBezierPath(ovalIn: NSRect(x: (x - 0.05) * side, y: 0.45 * side, width: 0.1 * side, height: 0.1 * side)).fill()
            }
        } else if state.needsYou {
            let bar = NSBezierPath()
            bar.move(to: p(0.5, 0.64))
            bar.line(to: p(0.5, 0.47))
            bar.lineWidth = side * 0.11
            bar.lineCapStyle = .round
            bar.stroke()
            NSBezierPath(ovalIn: NSRect(x: 0.44 * side, y: 0.27 * side, width: 0.12 * side, height: 0.12 * side)).fill()
        } else {
            let check = NSBezierPath()
            check.move(to: p(0.34, 0.50))
            check.line(to: p(0.45, 0.39))
            check.line(to: p(0.66, 0.62))
            check.lineWidth = side * 0.10
            check.lineCapStyle = .round
            check.lineJoinStyle = .round
            check.stroke()
        }
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

        // Calling performDrag UNCONDITIONALLY on the strip made the refresh button
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

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate,
    UNUserNotificationCenterDelegate, NSPopoverDelegate {
    var window: BoardWindow!
    var web: DragWebView!
    var timer: Timer?
    var statusItem: NSStatusItem!
    var menuIcon = MenuIconState()
    /// The right-click menu. Kept here because the status item no longer holds it.
    var statusMenu: NSMenu!
    let panel = NSPopover()
    /// One WebView per PANEL_TABS entry, in the same order; panelWeb is the Sprint board's.
    var panelTabs: [WKWebView] = []
    /// The widget's own tab header and Hosts page. Its Sprint page is `web`.
    var widgetTabControl: NSSegmentedControl!
    var widgetHostsWeb: WKWebView!
    var widgetHeader: NSView?
    var widgetTint: NSView?
    /// The height each widget page last reported, so the window follows the active tab.
    var widgetPageHeights: [WKWebView: CGFloat] = [:]
    /// The window height of the move under way, and a number that tells a newer move from an older one.
    var widgetFitTarget: CGFloat?
    var widgetFitRun = 0
    var panelWeb: WKWebView!
    var hostsWeb: WKWebView!
    var tabControl: NSSegmentedControl!
    /// The setup page (settings and sign-in) inside the panel, over the tabs, with a back arrow.
    /// Everything the widget's setup screen does, the panel does too.
    var panelSetupWeb: WKWebView!
    var panelSettingsShown = false
    /// The setup page that started a sign-in; its errors go back there.
    var setupResultTarget: WKWebView?
    /// Why sign-in is needed, for a panel setup page that opens after the widget took the error.
    var setupReason: String?
    /// The height each tab's page last reported; the panel fits the selected one.
    var panelPageHeights: [WKWebView: CGFloat] = [:]
    var retryTimer: Timer?
    var retryCount = 0
    /// A fetch.mjs run (or the keychain read before it) is under way. Main thread only.
    var fetchInFlight = false
    /// Counts the times the board's data was dropped (Disconnect, a session that ended): a fetch
    /// started before belongs to the account that left. Main thread only.
    var boardGeneration = 0
    /// Board pages (the widget's view.html, the panel's sprints.html) that have finished loading. A render sent
    /// to a page that is still loading is lost, so only these receive data.
    var loadedBoards = Set<WKWebView>()
    /// The last fetch result and the last successful one, replayed to a board page that
    /// finishes loading after they arrived.
    var lastJSON: String?
    var lastOkJSON: String?
    /// Whether the widget was hidden when Settings borrowed it; the way back hides it again.
    var widgetHiddenBeforeSetup: Bool?
    /// Event time of a click on the menu bar icon that closed the panel, so the same click
    /// does not open it again.
    var panelClosedByIconAt: TimeInterval?
    /// Set by "Refresh now" and the refresh button: the next result is reported as a notification.
    var manualRefreshPending = false
    /// The widget's frame before it was made to fill the screen; nil while it is normal size.
    var restoreFrame: NSRect?
    var dockItem: NSMenuItem?

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
        for source in [PANEL_PAGE_SCRIPT, WIDGET_PAGE_SCRIPT] {
            cfg.userContentController.addUserScript(WKUserScript(
                source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if let script = symbolScript() { cfg.userContentController.addUserScript(script) }

        let frame = savedFrame()
        window = BoardWindow(contentRect: frame, styleMask: [.borderless, .resizable, .miniaturizable],
                             backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        // The shadow follows the window's alpha, so it bends round the clear corners of the card.
        window.hasShadow = true
        window.isMovableByWindowBackground = true

        // The system material behind the transparent page. Always active: following the
        // window's key state would turn the panel flat whenever another app has focus.
        let material = NSVisualEffectView(frame: NSRect(origin: .zero, size: frame.size))
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        window.contentView = material
        applyCornerRadius(CARD_RADIUS)
        // NOTE: the desktop level (desktopIcon) was tried — the window received no mouse
        // events. Normal level: same plane as other windows, clicks/drags work.
        window.level = .normal
        // .canJoinAllSpaces WAS TRIED AND REMOVED: appearing on every Space put the
        // widget on top of full-screen apps. Keep it on the desktop Space.
        window.collectionBehavior = [.stationary, .ignoresCycle, .fullScreenNone]

        web = DragWebView(frame: material.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        material.addSubview(web)
        setUpWidgetTabs(in: material)

        if needsSetup() {
            onSetupScreen = true
            loadPage("setup.html")
        } else {
            loadPage(WIDGET_BOARD_PAGE)
        }

        // Menu bar item: with no Dock icon (LSUIElement) this is the ONLY UI route to
        // quitting the app. Without it you would need pkill from a terminal.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        // A template NSImage, NOT TEXT: a text glyph as `button.title` looked like a tiny
        // character rather than an icon and depended on the menu font. A template image fits the
        // menu height and tints itself for a light/dark menu bar.
        statusItem.button?.image = ringIcon(18)
        statusItem.button?.toolTip = "Sprint Board"
        let menu = NSMenu()
        let mRefresh = NSMenuItem(title: "Refresh now", action: #selector(menuRefresh), keyEquivalent: "r")
        let mFront = NSMenuItem(title: "Bring widget to front", action: #selector(menuFront), keyEquivalent: "")
        let mSetup = NSMenuItem(title: "Settings…", action: #selector(menuSettings), keyEquivalent: "")
        dockItem = NSMenuItem(title: "Show in Dock", action: #selector(toggleDock), keyEquivalent: "")
        dockItem?.state = dockChoice(UserDefaults.standard.object(forKey: SHOW_IN_DOCK_KEY)) ? .on : .off
        for m in [mRefresh, mFront, mSetup, dockItem!] { m.target = self; menu.addItem(m) }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Sprint Board", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        // NOT `statusItem.menu = menu`: with a menu attached every click opens it and the
        // button's action never fires. Left click opens the panel, right click this menu.
        statusMenu = menu
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusItemClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        setUpPanel()

        buildMainMenu()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { granted, err in
            dbg("notification permission granted=\(granted) \(err?.localizedDescription ?? "")")
        }

        window.orderFront(nil)
        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification,
                                               object: window, queue: .main) { [weak self] _ in
            guard self?.restoreFrame == nil else { return }
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
        manualRefreshPending = false
        setupFromSettings = !needsSetup()
        browsingSettings = setupFromSettings
        onSetupScreen = true
        lendWidgetToSetup()
        loadPage("setup.html")
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Settings… in the menu opens the panel's settings, so the widget is never needed.
    @objc func menuSettings() {
        if !panel.isShown { togglePanel() }
        showPanelSettings()
    }

    @objc func menuRefresh() {
        manualRefreshPending = true
        reload()
    }

    /// Brings the window back when it has ended up behind other windows, was minimised
    /// to the Dock, or was closed with the widget's own close button.
    @objc func menuFront() {
        // Asked for explicitly, so leaving Settings must not hide it again.
        widgetHiddenBeforeSetup = nil
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.orderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Without a Dock icon the app also leaves Cmd+Tab (macOS ties the two together);
    /// the menu bar item stays the way back.
    @objc func toggleDock() {
        let show = toggledDockChoice(UserDefaults.standard.object(forKey: SHOW_IN_DOCK_KEY))
        UserDefaults.standard.set(show, forKey: SHOW_IN_DOCK_KEY)
        NSApp.setActivationPolicy(show ? .regular : .accessory)
        dockItem?.state = show ? .on : .off
        if show { NSApp.activate(ignoringOtherApps: true) }
    }

    /// Cmd+Tab back to the app (only when it shows in the Dock) brings the widget back even
    /// after its close button hid it.
    ///
    /// Opening the panel also activates the app; that must not bring back a widget the user
    /// closed. Activation finishes after the panel is shown and can hand key status back to
    /// the widget, so the panel takes it again here (its inputs need it).
    func applicationDidBecomeActive(_ note: Notification) {
        if panel.isShown {
            panel.contentViewController?.view.window?.makeKey()
            return
        }
        if window != nil, !window.isVisible, !window.isMiniaturized { window.orderFront(nil) }
    }

    /// Signs this Mac out of Jira: the stored token or refresh token leaves the keychain and
    /// the identity leaves the config. Thresholds, sounds and notes stay. Only entries this
    /// app wrote are deleted; touching one made by hand with `security` opens a dialog.
    func disconnect() {
        guard let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
              var cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else { return }
        if cfg["tokensOwnedByApp"] as? Bool == true, let email = cfg["email"] as? String, !email.isEmpty {
            keychainDelete(service: JIRA_OAUTH_KEYCHAIN, account: email)
            if let service = appWrittenTokenService(cfg) { keychainDelete(service: service, account: email) }
        }
        for key in ["email", "host", "cloudId", "authMode", "tokensOwnedByApp"] { cfg.removeValue(forKey: key) }
        if let data = try? JSONSerialization.data(withJSONObject: cfg, options: .prettyPrinted) {
            try? data.write(to: URL(fileURLWithPath: CONFIG_PATH))
        }
        jiraAccessToken = nil
        jiraAccessExpiry = nil
        forgetCachedTokens()
        setupFromSettings = false
        browsingSettings = false
        manualRefreshPending = false
        onSetupScreen = true
        setupResultTarget = nil
        loadPage("setup.html")
        clearBoardData()
        if panelSettingsShown { fillPanelSettings() }
    }

    /// Writes the board settings from the setup screen. fetch.mjs reads the config on every
    /// run, so the next refresh uses them.
    func saveSettings(_ s: [String: Any], reply page: WKWebView) {
        guard let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
              var cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
            settingsResult(["errors": ["Could not read the config file."]], to: page); return
        }
        guard let org = githubOrgName((s["githubOrg"] as? String) ?? "") else {
            settingsResult(["errors": ["Not a valid GitHub organization name: letters, digits and single hyphens, at most 39 characters."]], to: page)
            return
        }
        // Only the popover's Settings sends them; a save from the widget leaves them as they are.
        if let typed = s["partnerDomainSuffixes"] as? String {
            guard let partners = partnerSuffixList(typed) else {
                settingsResult(["errors": ["Partner domains are domain names separated by commas, as in panel.example.com, api.example.com."]], to: page)
                return
            }
            cfg["partnerDomainSuffixes"] = partners
        }
        let drafts = (s["showDraftPrs"] as? Bool) ?? true
        let goals = (s["sprintGoalTracking"] as? Bool) ?? false
        cfg["githubOrg"] = org
        cfg["showDraftPrs"] = drafts
        cfg["sprintGoalTracking"] = goals
        guard let data = try? JSONSerialization.data(withJSONObject: cfg, options: .prettyPrinted),
              (try? data.write(to: URL(fileURLWithPath: CONFIG_PATH))) != nil else {
            settingsResult(["errors": ["Could not write the config file."]], to: page); return
        }
        settingsResult(["saved": true, "githubOrg": org, "showDraftPrs": drafts, "sprintGoalTracking": goals,
                        "partnerDomainSuffixes": partnerDomainSuffixes(cfg)], to: page)
    }

    func settingsResult(_ res: [String: Any], to page: WKWebView) {
        let json = (try? JSONSerialization.data(withJSONObject: res))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        page.evaluateJavaScript("window.sbSettingsResult && window.sbSettingsResult(\(json))")
    }

    /// The green button: the widget fills the screen with larger text; again restores it.
    func toggleFill() {
        if let frame = restoreFrame {
            web.pageZoom = 1
            widgetHostsWeb.pageZoom = 1
            // The animation runs a nested run loop: height reports must still wait until it ends.
            window.setFrame(frame, display: true, animate: true)
            restoreFrame = nil
        } else if let screen = window.screen ?? NSScreen.main {
            restoreFrame = window.frame
            web.pageZoom = 1.4
            widgetHostsWeb.pageZoom = 1.4
            window.setFrame(screen.visibleFrame, display: true, animate: true)
        }
        // The zoom scales the card's CSS corners; the material must follow them.
        applyCornerRadius(CARD_RADIUS * web.pageZoom)
        window.invalidateShadow()
        applyFillClass()
        if restoreFrame == nil {
            for page in [web, widgetHostsWeb] as [WKWebView] {
                page.evaluateJavaScript("window.sbFit && window.sbFit()") { _, err in
                    if let err { dbg("fit: \(err.localizedDescription)") }
                }
            }
        }
    }

    func applyCornerRadius(_ radius: CGFloat) {
        (window.contentView as? NSVisualEffectView)?.maskImage = roundedMask(radius)
        widgetTint?.layer?.cornerRadius = radius
    }

    func applyFillClass() {
        web.evaluateJavaScript("document.body.classList.toggle('filled', \(restoreFrame != nil))") { _, err in
            if let err { dbg("fill class: \(err.localizedDescription)") }
        }
    }

    /// Without an Edit menu macOS has nowhere to route Cmd+C / Cmd+V / Cmd+A, so the
    /// setup screen's inputs could not be pasted into.
    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Refresh now", action: #selector(menuRefresh), keyEquivalent: "r").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Sprint Board", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        NSApp.mainMenu = main
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        menuFront()
        return false
    }

    // MARK: widget tabs

    /// The tab header holds the window buttons, so both tabs have them. The Hosts page stays
    /// loaded behind the Sprint page, so each tab keeps its state, as in the panel. The setup
    /// screen uses the whole window and brings its own card and window buttons.
    func setUpWidgetTabs(in material: NSView) {
        let tint = NSView(frame: material.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = WIDGET_TINT.cgColor
        tint.layer?.cornerRadius = CARD_RADIUS
        tint.autoresizingMask = [.width, .height]
        material.addSubview(tint, positioned: .below, relativeTo: web)
        widgetTint = tint

        widgetHostsWeb = makePanelWebView(handler: "hosts")
        widgetHostsWeb.configuration.userContentController.addUserScript(WKUserScript(
            source: WIDGET_PAGE_SCRIPT, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        widgetHostsWeb.autoresizingMask = [.width, .height]
        widgetHostsWeb.isHidden = true
        material.addSubview(widgetHostsWeb)

        let width = material.bounds.width
        let header = NSView(frame: NSRect(x: 0, y: material.bounds.height - PANEL_HEADER_HEIGHT,
                                          width: width, height: PANEL_HEADER_HEIGHT))
        header.autoresizingMask = [.width, .minYMargin]
        header.appearance = NSAppearance(named: .darkAqua)
        material.addSubview(header)
        widgetHeader = header

        widgetTabControl = NSSegmentedControl(labels: PANEL_TABS.map(\.title), trackingMode: .selectOne,
                                              target: self, action: #selector(widgetTabChanged))
        widgetTabControl.sizeToFit()
        widgetTabControl.frame.origin = NSPoint(x: (width - widgetTabControl.frame.width) / 2,
                                                y: (PANEL_HEADER_HEIGHT - widgetTabControl.frame.height) / 2)
        widgetTabControl.autoresizingMask = [.minXMargin, .maxXMargin]
        header.addSubview(widgetTabControl)

        let lights: [(color: UInt32, action: String)] = [(0xff5f57, "close"), (0xfebc2e, "minimize"), (0x28c840, "fill")]
        for (i, light) in lights.enumerated() {
            let button = NSButton(frame: NSRect(x: 16 + CGFloat(i) * 20, y: (PANEL_HEADER_HEIGHT - 12) / 2, width: 12, height: 12))
            button.title = ""
            button.isBordered = false
            button.wantsLayer = true
            button.layer?.cornerRadius = 6
            button.layer?.backgroundColor = NSColor(srgbRed: CGFloat(light.color >> 16 & 255) / 255,
                                                    green: CGFloat(light.color >> 8 & 255) / 255,
                                                    blue: CGFloat(light.color & 255) / 255, alpha: 1).cgColor
            button.identifier = NSUserInterfaceItemIdentifier(light.action)
            button.toolTip = light.action
            button.target = self
            button.action = #selector(widgetLightClicked)
            header.addSubview(button)
        }

        loadPage("popover/hosts.html", in: widgetHostsWeb)
        let saved = UserDefaults.standard.integer(forKey: WIDGET_TAB_KEY)
        widgetTabControl.selectedSegment = PANEL_TABS.indices.contains(saved) ? saved : 0
        layoutWidget()
    }

    var widgetShownPage: WKWebView { widgetHostsWeb?.isHidden == false ? widgetHostsWeb : web }

    /// Places the header and the pages for the setup screen or the selected tab.
    func layoutWidget() {
        guard let header = widgetHeader, let material = window.contentView else { return }
        let tabs = !onSetupScreen
        let pageFrame = NSRect(x: 0, y: 0, width: material.bounds.width,
                               height: material.bounds.height - (tabs ? PANEL_HEADER_HEIGHT : 0))
        web.frame = pageFrame
        widgetHostsWeb.frame = pageFrame
        header.isHidden = !tabs
        widgetTint?.isHidden = !tabs
        let hostsShown = tabs && PANEL_TABS[widgetTabControl.selectedSegment].page == "popover/hosts.html"
        web.isHidden = hostsShown
        widgetHostsWeb.isHidden = !hostsShown
        fitWidget()
    }

    /// The window follows the active page. It keeps its top edge and never leaves the screen: it
    /// would run under the Dock and be saved so. While it fills the screen its size is fixed.
    /// With `animated` the bottom edge moves with the page's fold motion. A page reports its new
    /// height before its motion starts, so a move in one step cuts or uncovers the board before
    /// the content arrives. A WKWebView redraws at each resize, so the pages stay pinned at the
    /// taller height for the move and take their exact height once, at its end.
    func fitWidget(animated: Bool = false) {
        guard restoreFrame == nil, let height = widgetPageHeights[widgetShownPage] else { return }
        var f = window.frame
        let top = f.maxY
        f.size.height = height + (onSetupScreen ? 0 : PANEL_HEADER_HEIGHT)
        f.origin.y = top - f.height
        f = onScreen(f, near: window.frame)
        let now = window.frame
        if let target = widgetFitTarget {
            // A fold reports its height more than once; the move under way already goes there.
            if abs(f.height - target) < 0.5 { return }
        } else if abs(f.minX - now.minX) < 0.5, abs(f.minY - now.minY) < 0.5, abs(f.height - now.height) < 0.5 {
            return
        }
        widgetFitRun += 1
        let run = widgetFitRun
        let move = animated && window.isVisible && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let interrupted = widgetFitTarget != nil
        widgetFitTarget = move ? f.height : nil
        if move { pinWidgetPages(windowHeight: f.height) }
        guard move || interrupted else {
            window.setFrame(f, display: true)
            window.invalidateShadow()
            saveFrame()
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = move ? WIDGET_FIT_SECONDS : 0
            context.timingFunction = WIDGET_FIT_CURVE
            window.animator().setFrame(f, display: true)
        }, completionHandler: { [weak self] in
            guard let self, run == self.widgetFitRun else { return }
            self.widgetFitTarget = nil
            for page in [self.web, self.widgetHostsWeb] as [WKWebView] { page.autoresizingMask = [.width, .height] }
            self.layoutWidget()
            self.window.invalidateShadow()
            self.saveFrame()
        })
    }

    /// Pages keep their top edge and height while the window moves under them.
    func pinWidgetPages(windowHeight: CGFloat) {
        let height = windowHeight - PANEL_HEADER_HEIGHT
        for page in [web, widgetHostsWeb] as [WKWebView] {
            page.autoresizingMask = [.width, .minYMargin]
            guard height > page.frame.height else { continue }
            page.frame = NSRect(x: 0, y: page.frame.maxY - height, width: page.frame.width, height: height)
        }
    }

    @objc func widgetTabChanged() {
        UserDefaults.standard.set(widgetTabControl.selectedSegment, forKey: WIDGET_TAB_KEY)
        widgetShownPage.evaluateJavaScript("document.documentElement.classList.add('nohover')")
        layoutWidget()
        // /etc/hosts may have been edited by hand since the tab was last drawn.
        if widgetShownPage === widgetHostsWeb { hostsMessage(["status": true]) }
    }

    @objc func widgetLightClicked(_ button: NSButton) {
        windowAction(button.identifier?.rawValue ?? "")
    }

    func windowAction(_ action: String) {
        switch action {
        case "close": window.orderOut(nil)
        case "minimize": window.miniaturize(nil)
        case "fill": toggleFill()
        default: break
        }
    }

    // MARK: menu bar panel

    /// A tab header (one segment per PANEL_TABS entry) over one WebView per tab. The Sprint
    /// tab shows popover/sprints.html, fed the same data as the widget. All tab WebViews live as long as the app,
    /// so a page keeps its state (and its handler registration) across tab switches.
    func setUpPanel() {
        let size = NSSize(width: BOARD_WIDTH, height: PANEL_HEADER_HEIGHT + PANEL_START_HEIGHT)
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        panelTabs = PANEL_TABS.map { makePanelWebView(handler: $0.handler) }
        for w in panelTabs {
            w.frame = NSRect(x: 0, y: 0, width: size.width, height: PANEL_START_HEIGHT)
            w.autoresizingMask = [.width, .height]
            container.addSubview(w)
        }
        panelWeb = panelTabs[PANEL_TABS.firstIndex { $0.page == "popover/sprints.html" }!]
        hostsWeb = panelTabs[PANEL_TABS.firstIndex { $0.page == "popover/hosts.html" }!]
        // The setup page posts to "sb" as in the widget; the handler tells the two apart.
        panelSetupWeb = makePanelWebView(handler: "sb")
        panelSetupWeb.frame = NSRect(origin: .zero, size: size)
        panelSetupWeb.autoresizingMask = [.width, .height]
        panelSetupWeb.isHidden = true
        container.addSubview(panelSetupWeb)

        tabControl = NSSegmentedControl(labels: PANEL_TABS.map(\.title), trackingMode: .selectOne,
                                        target: self, action: #selector(panelTabChanged))
        tabControl.sizeToFit()
        // AppKit's y grows upwards: the header band is the top PANEL_HEADER_HEIGHT points.
        tabControl.frame.origin = NSPoint(x: (size.width - tabControl.frame.width) / 2,
                                          y: size.height - (PANEL_HEADER_HEIGHT + tabControl.frame.height) / 2)
        tabControl.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin]
        container.addSubview(tabControl)

        let content = NSViewController()
        content.view = container
        panel.contentViewController = content
        panel.contentSize = size
        panel.behavior = .transient
        panel.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        // The board is a dark card; a light popover frame around it looks broken.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.delegate = self
        for (w, tab) in zip(panelTabs, PANEL_TABS) { loadPage(tab.page, in: w) }
        loadPage("popover/settings.html", in: panelSetupWeb)
        let saved = UserDefaults.standard.integer(forKey: PANEL_TAB_KEY)
        selectPanelTab(panelTabs.indices.contains(saved) ? saved : 0)
    }

    /// A document-start script starts every panel page with `nohover`, which the hover styles of
    /// the buttons that swap pages wait on, and drops it on the first real mouse move (a moved
    /// pointer; WebKit's own re-checks move nothing).
    func makePanelWebView(handler: String) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: handler)
        cfg.userContentController.addUserScript(WKUserScript(
            source: PANEL_PAGE_SCRIPT, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let script = symbolScript() { cfg.userContentController.addUserScript(script) }
        cfg.setValue(false, forKey: "drawsBackground")
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.navigationDelegate = self
        w.setValue(false, forKey: "drawsBackground")
        return w
    }

    @objc func panelTabChanged() {
        selectPanelTab(tabControl.selectedSegment)
    }

    /// The panel page on screen, or on its way there; the others are hidden.
    var shownPanelPage: WKWebView?

    /// Puts one page on screen in the panel. A hidden WKWebView keeps the hover it was left with
    /// and showed it again on the way back (the gear after Back, the back arrow in Settings), and
    /// WebKit takes hover from the real cursor only. So the page being left turns its hover
    /// styles off (`nohover`) and paints that, two animation frames (~30 ms); then the two pages
    /// trade places in one step. Hover returns on the next real mouse move.
    func showPanelPage(_ page: WKWebView, then after: @escaping () -> Void = {}) {
        let leaving = shownPanelPage
        shownPanelPage = page
        var swapped = false
        let swap = { [weak self] in
            guard let self, !swapped else { return }
            swapped = true
            // A newer request took over; it does the swap.
            guard self.shownPanelPage === page else { return }
            for w in self.panelTabs + [self.panelSetupWeb!] { w.isHidden = w !== page }
            self.tabControl.isHidden = page === self.panelSetupWeb
            after()
        }
        let hoverOff = "document.documentElement.classList.add('nohover')"
        guard let leaving, leaving !== page, panel.isShown else {
            leaving?.evaluateJavaScript(hoverOff)
            swap()
            return
        }
        leaving.callAsyncJavaScript("\(hoverOff); await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
                                   arguments: [:], in: nil, in: .page) { _ in swap() }
        // Animation frames stop when the page cannot draw; the swap must happen anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { swap() }
    }

    func selectPanelTab(_ index: Int) {
        tabControl.selectedSegment = index
        UserDefaults.standard.set(index, forKey: PANEL_TAB_KEY)
        showPanelPage(panelTabs[index]) { [weak self] in
            guard let self else { return }
            self.fitPanel()
            // /etc/hosts may have been edited by hand since the tab was last drawn.
            if self.panelTabs[index] === self.hostsWeb { self.hostsMessage(["status": true]) }
        }
    }

    /// The setup page takes the whole panel, the tab header too; its back arrow returns to the
    /// tab that was open. Like the tabs it stays loaded: it is filled for this opening first and
    /// shown after, at its new height, so it opens in one step.
    func showPanelSettings() {
        panelSettingsShown = true
        fillPanelSettings { [weak self] height in
            guard let self, self.panelSettingsShown else { return }
            if let height { self.panelPageHeights[self.panelSetupWeb] = height }
            self.showPanelPage(self.panelSetupWeb) { [weak self] in self?.fitPanel() }
        }
    }

    /// Fills the panel's setup page: the account and the settings, or the sign-in block while
    /// sign-in is needed, and the reason the board stopped. Answers the page's height; nil before
    /// the page has loaded, and didFinish fills it then.
    func fillPanelSettings(_ done: @escaping (CGFloat?) -> Void = { _ in }) {
        let signInNeeded = onSetupScreen && !setupFromSettings
        var context: Any = NSNull()
        if !signInNeeded, let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
           let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
           let signedIn = setupContext(cfg) {
            context = signedIn
        }
        let errors = setupBlocksFetch ? [setupReason].compactMap { $0 } : []
        let args = (try? JSONSerialization.data(withJSONObject: [context, errors]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[null, []]"
        panelSetupWeb.evaluateJavaScript("window.sbSettingsShow ? window.sbSettingsShow(...\(args)) : null") { height, _ in
            done((height as? Double).map { CGFloat($0) })
        }
    }

    func hidePanelSettings() {
        guard panelSettingsShown else { return }
        panelSettingsShown = false
        selectPanelTab(tabControl.selectedSegment)
    }

    func panelPageHeight(_ height: CGFloat, for w: WKWebView) {
        panelPageHeights[w] = height
        if w === shownPanelPage { fitPanel() }
    }

    @objc func statusItemClicked() {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            panel.performClose(nil)
            statusItem.menu = statusMenu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
            return
        }
        // A transient popover closes on the mouse-down outside it, even when that mouse-down
        // is on the icon; without this check the same click's mouse-up would reopen it.
        if let closedAt = panelClosedByIconAt, event.timestamp - closedAt < 1 {
            panelClosedByIconAt = nil
            return
        }
        panelClosedByIconAt = nil
        togglePanel()
    }

    func togglePanel() {
        if panel.isShown { panel.performClose(nil); return }
        guard let button = statusItem.button else { return }
        // Sign-in or keychain access is needed: the panel opens on the setup page.
        if setupBlocksFetch, !panelSettingsShown { showPanelSettings() }
        fitPanel()   // the icon's screen may differ from the last time
        if shownPanelPage === hostsWeb, !panelSettingsShown { hostsMessage(["status": true]) }
        panel.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        // An accessory app's popover gets no keystrokes (the note field) until the app is active.
        NSApp.activate(ignoringOtherApps: true)
    }

    func popoverDidShow(_ note: Notification) {
        panel.contentViewController?.view.window?.makeKey()
    }

    func popoverWillClose(_ note: Notification) {
        // The page must not open next time with whatever was last clicked hovered; it paints
        // that while the popover fades out.
        shownPanelPage?.evaluateJavaScript("document.documentElement.classList.add('nohover')")
        if let event = NSApp.currentEvent, event.type == .leftMouseDown,
           event.window != nil, event.window === statusItem.button?.window {
            panelClosedByIconAt = event.timestamp
        }
    }

    /// Fits the panel to the selected tab's page, never taller than the screen; beyond that
    /// the page scrolls.
    func fitPanel() {
        guard let shown = shownPanelPage else { return }
        // The setup page has no tab header above it.
        let header = shown === panelSetupWeb ? 0 : PANEL_HEADER_HEIGHT
        let screen = statusItem.button?.window?.screen ?? NSScreen.main
        let maxPage = (screen?.visibleFrame.height ?? 800) - 40 - header
        let page = min(max(panelPageHeights[shown] ?? PANEL_START_HEIGHT, 40), maxPage)
        panel.contentSize = NSSize(width: BOARD_WIDTH, height: header + page)
    }

    /// Settings opens in the widget: OAuth goes through the browser, and a transient panel
    /// would close the moment the browser comes forward. Whether the widget was hidden is
    /// remembered so showBoard() can hide it again.
    func lendWidgetToSetup() {
        // Minimised is not closed: a minimised widget reports isVisible == false too.
        if widgetHiddenBeforeSetup == nil { widgetHiddenBeforeSetup = !window.isVisible && !window.isMiniaturized }
        panel.performClose(nil)
        // A panel page that loaded before this point would otherwise keep counting
        // "fetching data…" while nothing will arrive until setup is done.
        if lastJSON == nil {
            for w in loadedBoards where w !== web { render(SETUP_PENDING_RESULT, in: w) }
        }
    }

    /// Back from the setup screen to the board, whichever way: Back to board or a finished
    /// sign-in.
    func showBoard() {
        onSetupScreen = false
        setupFromSettings = false
        browsingSettings = false
        setupResultTarget = nil
        setupReason = nil
        hidePanelSettings()
        loadPage(WIDGET_BOARD_PAGE)
        // With no data yet the panel still says "action needed"; reloading it shows the
        // loading ticker until the first result.
        if lastJSON == nil { loadPage("popover/sprints.html", in: panelWeb) }
        reload()
        if widgetHiddenBeforeSetup == true { window.orderOut(nil) }
        widgetHiddenBeforeSetup = nil
    }

    /// Signed out: no board, nor the menu bar icon, may keep showing the previous account.
    /// Reloading the panel's page also drops the page's own copy of the last good data (LAST_OK).
    func clearBoardData() {
        lastJSON = nil
        lastOkJSON = nil
        boardGeneration += 1
        menuIcon = MenuIconState()
        statusItem.button?.image = ringIcon(18, menuIcon)
        loadPage("popover/sprints.html", in: panelWeb)
    }

    // MARK: hosts

    /// One change at a time, and the file I/O stays off the main thread.
    let hostsQueue = DispatchQueue(label: "sprint-board.hosts")

    func readHostsList() -> HostsList? {
        guard let d = FileManager.default.contents(atPath: HOSTS_LIST_PATH) else { return nil }
        return hostsList(fromJSON: try? JSONSerialization.jsonObject(with: d))
    }

    func writeHostsList(_ list: HostsList) -> Bool {
        try? FileManager.default.createDirectory(atPath: (HOSTS_LIST_PATH as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true)
        guard let d = try? JSONSerialization.data(withJSONObject: hostsListJSON(list), options: .prettyPrinted) else {
            return false
        }
        return (try? d.write(to: URL(fileURLWithPath: HOSTS_LIST_PATH), options: .atomic)) != nil
    }

    /// Messages from popover/hosts.html (see hostsApply for the actions; status and importAll on top).
    /// Every action is answered with the full state, its error included, so a failure is never
    /// silent. The list is saved before the block is written; the block is not written when the
    /// list could not be saved, and the saved list is rolled back when the block could not be
    /// written, so the two stay in step.
    func hostsMessage(_ body: [String: Any]) {
        if body["openChrome"] != nil {
            chromeQueue.async { [weak self] in self?.openInsecureChrome() }
            return
        }
        // The gear: Settings over the tabs; its back arrow returns to Hosts.
        if body["settings"] != nil {
            showPanelSettings()
            return
        }
        // The page also posts its height here; that is not an action and must not be
        // answered, or every redraw would ask for the next one.
        let actions = ["status", "add", "addPartner", "remove", "setMode", "groupAdd", "groupRename", "groupDelete",
                       "groupDeleteWithDomains", "member", "importAll"]
        guard body.keys.contains(where: actions.contains) else { return }
        hostsQueue.async { [weak self] in
            guard let self else { return }
            let writable = FileManager.default.isWritableFile(atPath: HOSTS_PATH)
            // An unreadable file is NOT an empty one: read as empty it would show every domain
            // as prod while the block still points them at this machine.
            guard let text = self.readHostsText() else {
                var state = hostsStatus("", self.readHostsList() ?? HostsList(), writable: writable)
                state["mode"] = "unreadable"
                state["error"] = "Could not read /etc/hosts as text, so nothing can be shown or changed."
                self.replyHosts(state, to: body)
                return
            }
            let saved = self.readHostsList()
            if saved == nil, FileManager.default.fileExists(atPath: HOSTS_LIST_PATH) {
                var state = hostsStatus(text, HostsList(), writable: writable)
                state["error"] = "Could not read the domain list (\(HOSTS_LIST_PATH)). Fix or delete that file; nothing was changed."
                self.replyHosts(state, to: body)
                return
            }
            let before = saved ?? HostsList()
            let block = managedHosts(text)
            // With a damaged block nobody can tell which domains are local, so nothing that
            // would change the block may run (the page disables these too).
            if block == nil, body["remove"] != nil || body["setMode"] != nil || body["groupDeleteWithDomains"] != nil {
                var state = hostsStatus(text, before, writable: writable)
                state["error"] = "Sprint Board's block in /etc/hosts is damaged; fix it by hand first. Nothing was changed."
                self.replyHosts(state, to: body)
                return
            }
            var action = body
            if body["importAll"] != nil {
                action["addMany"] = hostsImportable(text, before.domains + (block ?? []))
                action["addManyGroups"] = hostsImportGroups(text)
            }
            let result = hostsApply(before, local: block ?? [], action, partners: self.hostsPartnerSuffixes())
            var list = result.list
            var error = result.error

            // Saved on first use too, so names adopted from the block survive their next prod.
            if list != before || (saved == nil && !list.domains.isEmpty) {
                if !self.writeHostsList(list) {
                    list = before
                    error = "Could not save the domain list to \(HOSTS_LIST_PATH); nothing was changed."
                }
            }
            // Opening the tab only reads: a status never writes /etc/hosts or refreshes Chrome,
            // whatever the block holds. Compared as sets: the block's order (or a hand-made ::1
            // line) is no reason to rewrite /etc/hosts when nobody switched anything.
            if body["status"] == nil, list == result.list, Set(result.local) != Set(block ?? []) {
                if let failed = writeHostsBlock(result.local, path: HOSTS_PATH, backupDir: HOSTS_BACKUP_DIR) {
                    error = failed
                    // Keep the list in step with the block that stayed as it was.
                    if list != before, self.writeHostsList(before) { list = before }
                } else {
                    self.scheduleChromeRefresh()
                }
            }

            var state = self.readHostsText().map { hostsStatus($0, list, writable: writable) }
                ?? hostsStatus("", list, writable: writable).merging(["mode": "unreadable"]) { $1 }
            if let error { state["error"] = error }
            self.replyHosts(state, to: body)
        }
    }

    func readHostsText() -> String? {
        FileManager.default.contents(atPath: HOSTS_PATH).flatMap(hostsFileText)?.text
    }

    func hostsPartnerSuffixes() -> [String] {
        let config = (try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        return partnerDomainSuffixes(config)
    }

    /// The page gets the partner suffixes with every state, so "Add partner" follows the config,
    /// and the requestId of the message answered, so it can tell its action's reply from a state
    /// Swift sent on its own (the panel opened, a tab switch).
    func replyHosts(_ state: [String: Any], to body: [String: Any]) {
        var state = state
        state["partnerSuffixes"] = hostsPartnerSuffixes()
        state["requestId"] = body["requestId"]
        let json = (try? JSONSerialization.data(withJSONObject: state))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        DispatchQueue.main.async {
            for page in [self.hostsWeb, self.widgetHostsWeb] as [WKWebView] {
                page.evaluateJavaScript("window.sbHosts && window.sbHosts(\(json))") { _, err in
                    if let err { dbg("sbHosts: \(err.localizedDescription)") }
                }
            }
        }
    }

    // MARK: Chrome refresh

    /// The refresh still waiting to run; a burst of switches runs it once. Main thread only.
    var chromeRefresh: DispatchWorkItem?
    let chromeQueue = DispatchQueue(label: "sprint-board.chrome")

    /// After Sprint Board's block changed (see chromeRefreshScript for why).
    func scheduleChromeRefresh() {
        DispatchQueue.main.async {
            self.chromeRefresh?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.refreshChrome() }
            self.chromeRefresh = item
            self.chromeQueue.asyncAfter(deadline: .now() + 0.3, execute: item)
        }
    }

    func refreshChrome() {
        // Not running: nothing holds an old connection, and a note from earlier no longer applies.
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").isEmpty else {
            showChromeNote(nil)
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", chromeRefreshScript()]
        let err = Pipe()
        p.standardOutput = FileHandle.nullDevice
        p.standardError = err
        do { try p.run() } catch {
            showChromeNote("Could not refresh Chrome: \(error.localizedDescription)")
            return
        }
        let deadline = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + CHROME_REFRESH_TIMEOUT, execute: deadline)
        let out = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        deadline.cancel()
        if !out.isEmpty { dbg("chrome refresh (exit \(p.terminationStatus)): \(out)") }
        showChromeNote(chromeRefreshNote(status: p.terminationStatus, stderr: out,
                                         timedOut: p.terminationReason == .uncaughtSignal))
    }

    /// The Hosts tab's Chrome button: starts Chrome with CHROME_INSECURE_FLAGS, or brings it to
    /// the front when it already runs with them. A Chrome already running without them is left
    /// alone (flags only apply at launch, and a restart would lose its tabs and session cookies);
    /// the note says to quit it first. Runs on chromeQueue.
    func openInsecureChrome() {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            showChromeNote("Google Chrome is not installed.")
            return
        }
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first {
            let ps = Process()
            ps.executableURL = URL(fileURLWithPath: "/bin/ps")
            ps.arguments = ["-ww", "-o", "args=", "-p", String(running.processIdentifier)]
            let out = Pipe()
            ps.standardOutput = out
            ps.standardError = FileHandle.nullDevice
            do { try ps.run() } catch {
                showChromeNote("Could not check how Chrome was started: \(error.localizedDescription)")
                return
            }
            let commandLine = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            ps.waitUntilExit()
            let missing = chromeMissingFlags(commandLine)
            // An empty answer means Chrome quit meanwhile: start it below.
            if !commandLine.isEmpty, !missing.isEmpty {
                showChromeNote("Chrome is already open without \(missing.joined(separator: " ")): quit it (⌘Q) and press the Chrome button again.")
                return
            }
        }
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = CHROME_INSECURE_FLAGS
        config.activates = true
        DispatchQueue.main.async {
            NSWorkspace.shared.openApplication(at: app, configuration: config) { [weak self] _, error in
                self?.showChromeNote(error.map { "Could not open Chrome: \($0.localizedDescription)" })
            }
        }
    }

    /// Shows a note under the Hosts list; nil clears it.
    func showChromeNote(_ note: String?) {
        let arg = (try? JSONSerialization.data(withJSONObject: note.map { $0 as Any } ?? NSNull(), options: .fragmentsAllowed))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        DispatchQueue.main.async {
            for page in [self.hostsWeb, self.widgetHostsWeb] as [WKWebView] {
                page.evaluateJavaScript("window.sbHostsNote && window.sbHostsNote(\(arg))") { _, err in
                    if let err { dbg("sbHostsNote: \(err.localizedDescription)") }
                }
            }
        }
    }

    // MARK: notifications

    func notifyUser(id: String, title: String, body: String, url: String?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        // Silent: a new conflict usually also plays fetch.mjs's alert sound, and two sounds
        // for one event is noise.
        if let url { content.userInfo = ["url": url] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { err in
            if let err { dbg("notification failed: \(err.localizedDescription)") }
        }
    }

    /// New conflicts always notify; a refresh the user asked for also reports its result.
    func notifyFromResult(_ obj: [String: Any]?, ok: Bool) {
        let notes = resultNotifications(obj, ok: ok, manual: manualRefreshPending, onSetupScreen: setupBlocksFetch)
        for n in notes {
            guard let id = n["id"], let title = n["title"] else { continue }
            notifyUser(id: id, title: title, body: n["body"] ?? "", url: n["url"])
        }
        if !setupBlocksFetch { manualRefreshPending = false }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: s),
           url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }

    func savedFrame() -> NSRect {
        let d = UserDefaults.standard
        let x = d.object(forKey: "sbX") as? Double
        let y = d.object(forKey: "sbY") as? Double
        let h = d.object(forKey: "sbH") as? Double ?? 420
        guard let screen = NSScreen.main else {
            return NSRect(x: 40, y: 40, width: BOARD_WIDTH, height: h)
        }
        // Default: top-left corner (on macOS y is measured from the bottom up).
        let vf = screen.visibleFrame
        return onScreen(NSRect(x: x ?? (vf.minX + 40),
                               y: y ?? (vf.maxY - h - 40),
                               width: BOARD_WIDTH, height: h))
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
    var onSetupScreen = false {
        didSet { DispatchQueue.main.async { [weak self] in self?.layoutWidget() } }
    }
    /// The setup screen was opened from Settings while signed in, so it offers "Back to board".
    var setupFromSettings = false
    /// The user opened Settings while signed in: nothing is wrong, so refreshes go on behind it
    /// and reach the panel. A setup screen that opened itself (sign-in needed, or macOS refused
    /// the token read) stops them, or each one would ask again.
    var browsingSettings = false
    var setupBlocksFetch: Bool { onSetupScreen && !browsingSettings }

    /// Loads an HTML page from the bundle/repo, into the widget unless told otherwise.
    func loadPage(_ name: String, in view: WKWebView? = nil) {
        let target: WKWebView = view ?? web
        // Not a board until this load finishes (didFinish adds the board pages back).
        loadedBoards.remove(target)
        let url = URL(fileURLWithPath: "\(APP_DIR)/\(name)")
        target.loadFileURL(url, allowingReadAccessTo: URL(fileURLWithPath: APP_DIR))
    }

    func setupFailed(_ errors: [String]) {
        let json = (try? JSONSerialization.data(withJSONObject: ["errors": errors]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? #"{"errors":["unknown error"]}"#
        DispatchQueue.main.async {
            (self.setupResultTarget ?? self.web).evaluateJavaScript("window.sbSetupResult(\(json))") { _, err in
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

        DispatchQueue.main.async { self.showBoard() }
    }

    /// The API-token route, for when "Sign in with Atlassian" is not available. The token
    /// is checked against Jira first, then stored by this app, so reading it back opens no
    /// keychain permission dialog.
    func finishTokenLogin(host rawHost: String, email: String, token: String) {
        guard let host = jiraCloudHost(rawHost), let url = URL(string: "https://\(host)/rest/api/3/myself") else {
            setupFailed(["Enter your Jira Cloud site, like yourcompany.atlassian.net."]); return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 25
        req.setValue("Basic \(Data("\(email):\(token)".utf8).base64EncodedString())", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let done = DispatchSemaphore(value: 0)
        var status: Int?
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            status = (resp as? HTTPURLResponse)?.statusCode
            done.signal()
        }.resume()
        done.wait()
        switch status {
        case 200: break
        case 401, 403: setupFailed(["Jira did not accept this email and token."]); return
        case nil: setupFailed(["Could not reach \(host)."]); return
        case let code?: setupFailed(["Jira answered HTTP \(code) from \(host)."]); return
        }
        guard keychainSet(service: JIRA_TOKEN_KEYCHAIN, account: email, value: token) else {
            setupFailed(["Could not save the token to the keychain."]); return
        }
        forgetCachedTokens()

        var cfg = (try? JSONSerialization.jsonObject(with: Data(contentsOf:
                    URL(fileURLWithPath: "\(APP_DIR)/config.example.json")))) as? [String: Any] ?? [:]
        if let existing = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
           let old = try? JSONSerialization.jsonObject(with: existing) as? [String: Any] {
            cfg = old
        }
        // Switching away from "Sign in with Atlassian": its session must not linger.
        if (cfg["authMode"] as? String) == "oauth", let oldEmail = cfg["email"] as? String, !oldEmail.isEmpty {
            keychainDelete(service: JIRA_OAUTH_KEYCHAIN, account: oldEmail)
            jiraAccessToken = nil
            jiraAccessExpiry = nil
        }
        // Nor may the token this replaces (the first version kept it under sprint-board-jira).
        if let oldService = appWrittenTokenService(cfg), let oldEmail = cfg["email"] as? String, !oldEmail.isEmpty,
           !(oldService == JIRA_TOKEN_KEYCHAIN && oldEmail == email) {
            keychainDelete(service: oldService, account: oldEmail)
        }
        cfg["host"] = host
        cfg["email"] = email
        cfg["keychainService"] = JIRA_TOKEN_KEYCHAIN
        cfg["tokensOwnedByApp"] = true
        cfg.removeValue(forKey: "authMode")
        cfg.removeValue(forKey: "cloudId")
        if let data = try? JSONSerialization.data(withJSONObject: cfg, options: .prettyPrinted) {
            try? FileManager.default.createDirectory(
                atPath: (CONFIG_PATH as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: CONFIG_PATH))
        }

        DispatchQueue.main.async { self.showBoard() }
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

    /// The Jira API token, read from the keychain once per launch. Unless the user chose
    /// "Always Allow", macOS asks for permission on EVERY read, and the board refreshes every
    /// 30 minutes (plus ⟳ and retries) — re-reading each time asked again and again. Kept in
    /// memory like the OAuth access token; forgotten when this app replaces or removes the
    /// token (sign-in, Disconnect), and on quit. Only app-written tokens are cached: the
    /// GitHub token can change outside the app, so it is still read on every refresh.
    var keychainCache: [String: String] = [:]
    /// Bumped by forgetCachedTokens, so a read that was under way then does not store the
    /// old token afterwards.
    var keychainCacheGeneration = 0
    /// Guards the two above only, never a keychain read: a read can wait on a permission
    /// dialog, and Disconnect (main thread) must not wait with it.
    let keychainCacheLock = NSLock()

    func cachedKeychainGet(service: String, account: String) -> String? {
        let key = service + "\n" + account
        keychainCacheLock.lock()
        let hit = keychainCache[key], generation = keychainCacheGeneration
        keychainCacheLock.unlock()
        if let hit { return hit }
        let value = keychainGet(service: service, account: account)
        keychainCacheLock.lock()
        if let value, generation == keychainCacheGeneration { keychainCache[key] = value }
        keychainCacheLock.unlock()
        return value
    }

    func forgetCachedTokens() {
        keychainCacheLock.lock()
        keychainCache.removeAll()
        keychainCacheGeneration += 1
        keychainCacheLock.unlock()
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
                if let t = cachedKeychainGet(service: jiraSvc, account: email) {
                    out["jiraToken"] = t
                } else {
                    // Without this the run went on to fetch.mjs, whose `security` fallback
                    // raised a second permission dialog and then left the user to find
                    // Settings themselves. Missing: the item is gone. Denied: the read was
                    // refused (Deny in macOS's dialog).
                    out["jiraAuthState"] = keychainHas(service: jiraSvc, account: email) ? "tokenDenied" : "tokenMissing"
                }
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
    /// `canGoBack`: the sign-in itself is fine (macOS refused the token read), so the setup
    /// screen offers "Back to board" to try again and the boards keep their data.
    func requireLogin(_ reason: String, canGoBack: Bool = false) {
        DispatchQueue.main.async {
            guard !self.onSetupScreen else { return }
            self.onSetupScreen = true
            self.setupFromSettings = canGoBack
            self.browsingSettings = false
            self.manualRefreshPending = false
            self.pendingSetupError = reason
            self.setupReason = reason
            // The panel is in use, or the widget was closed: sign in happens in the panel, now or
            // the next time it opens. The widget keeps the setup screen without coming forward.
            let widgetClosed = !self.window.isVisible && !self.window.isMiniaturized
            if self.panel.isShown || widgetClosed {
                self.loadPage("setup.html")
                if !canGoBack { self.clearBoardData() }
                if self.panel.isShown { self.showPanelSettings() }
                return
            }
            self.lendWidgetToSetup()
            self.loadPage("setup.html")
            if !canGoBack { self.clearBoardData() }
            NSApp.activate(ignoringOtherApps: true)
            self.window.makeKeyAndOrderFront(nil)
        }
    }

    func reload() {
        // A refresh asked for on the setup screen never runs, so it must not wait to
        // report itself on the next automatic one.
        if setupBlocksFetch { manualRefreshPending = false; return }
        // One fetch at a time. A second one queued behind a keychain permission dialog would
        // ask again right after a Deny; a refresh asked for meanwhile is reported by the
        // running fetch (manualRefreshPending).
        guard !fetchInFlight else { return }
        fetchInFlight = true
        let generation = boardGeneration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            // Queued after any push() below, so the flag clears once its result is handled. When
            // the account left while it ran, push() dropped the result and the board now signed
            // in gets its own fetch instead of waiting for the timer.
            defer {
                DispatchQueue.main.async {
                    self.fetchInFlight = false
                    if generation != self.boardGeneration { self.reload() }
                }
            }
            guard let node = NODE else {
                self.push(#"{"ok":false,"error":"node not found — looked in /opt/homebrew/bin, /usr/local/bin and /usr/bin"}"#,
                          for: generation)
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
            switch self.authState(payload) {
            case "needsLogin":
                self.requireLogin("Your Atlassian session has ended — please sign in again.")
                return
            case "tokenMissing":
                self.requireLogin("Your Jira API token is no longer in the keychain — enter it again.")
                return
            case "tokenDenied":
                self.requireLogin("macOS did not let Sprint Board read your Jira token. Press Back to board and choose Allow when macOS asks.",
                                  canGoBack: true)
                return
            default:
                break
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
                self.push(#"{"ok":false,"error":"could not run fetch.mjs: \#(error)"}"#, for: generation)
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
            self.push(out.isEmpty ? #"{"ok":false,"error":"fetch.mjs produced no output"}"# : out, for: generation)
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

    func push(_ json: String, for generation: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
            let ok = obj?["ok"] as? Bool ?? false
            // Before the setup-screen check: fetch.mjs has already remembered these
            // conflicts, so one dropped here would never notify.
            self.notifyFromResult(obj, ok: ok)
            if self.setupBlocksFetch { return }
            if generation != self.boardGeneration { return }
            if ok { self.retryCount = 0; self.retryTimer?.invalidate() } else { self.scheduleRetry() }

            self.lastJSON = json
            if ok { self.lastOkJSON = json }
            self.menuIcon = menuIconState(obj, ok: ok, previous: self.menuIcon)
            self.statusItem.button?.image = ringIcon(18, self.menuIcon)
            for w in self.loadedBoards { self.render(json, in: w) }
        }
    }

    func render(_ json: String, in w: WKWebView) {
        let escaped = json.data(using: .utf8).flatMap {
            String(data: try! JSONSerialization.data(withJSONObject: [String(data: $0, encoding: .utf8)!],
                                                     options: [.fragmentsAllowed]), encoding: .utf8)
        } ?? "[\"{}\"]"
        // escaped: ["<json text>"] -> we take [0] back out and parse it.
        // Errors are NOT swallowed: with completionHandler nil the page got stuck
        // on "loading" leaving no trace whatsoever. Now it reaches the log.
        w.evaluateJavaScript("window.sbRender(JSON.parse(\(escaped)[0]))") { _, err in
            if let err { NSLog("SB: sbRender hatasi: \(err.localizedDescription)") }
        }
    }

    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        // Opened before its first load finished (the panel opening on sign-in at launch).
        if w === panelSetupWeb, panelSettingsShown { fillPanelSettings() }
        if w === web {
            if restoreFrame != nil { applyFillClass() }
            if onSetupScreen, setupFromSettings,
               let raw = try? Data(contentsOf: URL(fileURLWithPath: CONFIG_PATH)),
               let cfg = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
               let context = setupContext(cfg) {
                let ctx = (try? JSONSerialization.data(withJSONObject: context))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                w.evaluateJavaScript("window.sbSetupContext && window.sbSetupContext(\(ctx))")
            }
            if let msg = pendingSetupError {
                pendingSetupError = nil
                let json = (try? JSONSerialization.data(withJSONObject: ["errors": [msg]]))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                w.evaluateJavaScript("window.sbSetupResult && window.sbSetupResult(\(json))")
            }
        }
        guard ["view.html", "sprints.html"].contains(w.url?.lastPathComponent ?? "") else { return }
        loadedBoards.insert(w)
        // A page that loads after the data arrived gets it now. The last good result goes
        // first, so a failed latest refresh still shows as a strip over the old data.
        if let good = lastOkJSON, good != lastJSON { render(good, in: w) }
        if let last = lastJSON {
            render(last, in: w)
        } else if onSetupScreen {
            render(SETUP_PENDING_RESULT, in: w)
        }
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
            for w in self?.loadedBoards ?? [] {
                w.evaluateJavaScript("window.sbNotes && window.sbNotes(\(j))") { _, err in
                    if let err { dbg("sbNotes: \(err.localizedDescription)") }
                }
            }
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
        // Every panel tab sizes the panel the same way, whatever its handler.
        if let w = msg.webView, panelTabs.contains(w) || w === panelSetupWeb, let h = body["height"] as? Double {
            panelPageHeight(CGFloat(h), for: w)
        }
        if let w = msg.webView, w === web || w === widgetHostsWeb, let posted = body["height"] as? Double, posted > 60 {
            let known = widgetPageHeights[w] != nil
            widgetPageHeights[w] = CGFloat(posted)
            if w === widgetShownPage { fitWidget(animated: known && w === web && !onSetupScreen) }
        }
        // Below is the board/setup protocol. Other tabs' pages post to their own handlers
        // and must not reach it.
        if msg.name == "hosts" {
            // The widget's Hosts gear opens the widget's settings; the panel may be closed.
            if msg.webView === widgetHostsWeb, body["settings"] != nil { menuSetup(); return }
            hostsMessage(body)
            return
        }
        guard msg.name == "sb" else { return }
        // The panel's board and its setup page share this handler. Window keys belong to the
        // widget; setup messages come from the widget or the panel's setup page, never the board.
        let fromWidget = msg.webView === web
        let fromPanelSetup = msg.webView === panelSetupWeb
        let fromSetupPage = fromWidget || fromPanelSetup

        if let urlStr = body["open"] as? String, let url = URL(string: urlStr),
           url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        if body["refresh"] != nil {
            if setupBlocksFetch, let w = msg.webView, loadedBoards.contains(w) {
                // reload() does nothing while sign-in or token access is needed. Answer the panel's ⟳
                // anyway, as a failed refresh: its spinner stops, and with old data on
                // screen the board shows this as the "could not refresh" strip.
                render(SETUP_PENDING_RESULT, in: w)
            } else {
                manualRefreshPending = true
                reload()
            }
        }
        if body["atlassianLogin"] != nil, fromSetupPage {
            setupResultTarget = msg.webView
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.startAtlassianLogin() }
        }
        if fromSetupPage, let t = body["tokenLogin"] as? [String: Any], let host = t["host"] as? String,
           let email = t["email"] as? String, let token = t["token"] as? String {
            setupResultTarget = msg.webView
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.finishTokenLogin(host: host, email: email, token: token)
            }
        }
        if let t = body["noteAdd"] as? String { addNote(t) }
        if let i = body["noteDel"] as? String { removeNote(i) }
        // The panel's gear opens the panel's settings; the widget's opens the widget's.
        if body["settings"] != nil, !fromWidget { showPanelSettings() }
        if body["settings"] != nil, fromWidget {
            if onSetupScreen {
                // Already open in the widget, possibly behind other windows.
                panel.performClose(nil)
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
            } else {
                menuSetup()
            }
        }
        let setupOpen = (fromWidget && onSetupScreen) || fromPanelSetup
        if let s = body["saveSettings"] as? [String: Any], setupOpen, let page = msg.webView { saveSettings(s, reply: page) }
        if body["disconnect"] != nil, setupOpen { disconnect() }
        if body["backToBoard"] != nil, fromWidget, onSetupScreen { showBoard() }
        if body["backToBoard"] != nil, fromPanelSetup {
            // Back from a setup page that stopped the refreshes (macOS refused the keychain read)
            // tries again, as the widget's Back to board does; otherwise it only closes the page.
            if setupBlocksFetch, setupFromSettings { showBoard() } else { hidePanelSettings() }
        }
        if fromWidget, let w = body["win"] as? String {
            windowAction(w)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
// Out of the Dock unless the user chose "Show in Dock": Cmd+Tab only lists apps that have a
// Dock icon, and the two come together.
app.setActivationPolicy(dockChoice(UserDefaults.standard.object(forKey: SHOW_IN_DOCK_KEY)) ? .regular : .accessory)
app.run()
