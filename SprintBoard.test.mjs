import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SWIFT_URL = new URL("./SprintBoard.swift", import.meta.url);

function swiftSource(src, name) {
  const start = src.indexOf(`\nfunc ${name}(`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${name} not found in SprintBoard.swift`);
  return src.slice(start + 1, end + 3);
}

function swiftDecl(src, header) {
  const start = src.indexOf(`\n${header}`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${header} not found in SprintBoard.swift`);
  return src.slice(start + 1, end + 3);
}

function methodSource(src, name) {
  const at = src.search(new RegExp(`\\n    (?:@objc )?func ${name}\\(`));
  const end = src.indexOf("\n    }\n", at);
  assert.ok(at >= 0 && end > at, `${name} not found in SprintBoard.swift`);
  return src.slice(at + 1, end + 7);
}

let appDriver, appDir;
function appRun(input, env = {}) {
  if (!appDriver) {
    const src = readFileSync(SWIFT_URL, "utf8");
    const consts = ["HOSTS_BLOCK_START", "HOSTS_BLOCK_END", "HOSTS_LEGACY_BLOCK_START", "HOSTS_LEGACY_BLOCK_END", "HOSTS_SYSTEM_NAMES",
      "HOSTS_LOCAL_ADDRESSES", "HOSTS_DELETE_BACKUP_PREFIX", "HOSTS_DELETE_BACKUPS_KEPT", "PARTNERS_GROUP"].map((name) => {
      const line = src.match(new RegExp(`^let ${name} = .*$`, "m"));
      assert.ok(line, `${name} not found in SprintBoard.swift`);
      return line[0];
    });
    const decls = ["struct HostsGroup", "struct HostsList", "struct HostsRow", "struct HostsEdit"].map((header) => swiftDecl(src, header));
    const funcs = ["hostsName", "hostsEntry", "hostsMarkers", "hostsBlockRange", "managedHosts", "hostsLocalLine", "hostsCommented",
      "hostsUncommented", "hostsLineWithout", "hostsEntryWithout", "hostsRows", "hostsSwitched", "hostsAdded", "hostsRemoved", "hostsEdited",
      "hostsPartnerName", "partnerDomainSuffixes", "hostsGroupName", "hostsList", "hostsListJSON", "hostsApply", "hostsStatus",
      "hostsFileText", "hostsDeleteBackupName", "hostsDeleteBackupPath", "hostsDeleteBackupsPast", "writeHostsFile"].map((name) => swiftSource(src, name));
    const methods = ["readHostsList", "writeHostsList", "migrateHostsList", "hostsMessage", "readHostsText", "hostsPartnerSuffixes"]
      .map((name) => methodSource(src, name));
    const driver = `import Foundation
let env = ProcessInfo.processInfo.environment
let HOSTS_PATH = env["SB_HOSTS"] ?? ""
let HOSTS_LIST_PATH = env["SB_LIST"] ?? ""
let HOSTS_BACKUP_DIR = env["SB_BACKUP"] ?? ""
let CONFIG_PATH = env["SB_CONFIG"] ?? ""
${consts.join("\n")}
${decls.join("\n")}
${funcs.join("\n")}
func dbg(_ s: String) {}

final class App {
    let hostsQueue = DispatchQueue(label: "test.hosts")
    let chromeQueue = DispatchQueue(label: "test.chrome")
    var replies: [[String: Any]] = []
    var chromeRefreshes = 0
    func replyHosts(_ state: [String: Any], to body: [String: Any]) { replies.append(state) }
    func scheduleChromeRefresh() { chromeRefreshes += 1 }
    func openInsecureChrome() {}
${methods.join("\n")}
}

let input = try! JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
var out: [String: Any] = [:]
switch input["op"] as! String {
case "hosts":
    let app = App()
    app.hostsMessage(input["body"] as! [String: Any])
    app.hostsQueue.sync {}
    out = ["reply": app.replies.last ?? [:], "refreshes": app.chromeRefreshes]
case "list":
    out = ["list": hostsList(fromJSON: input["json"]).map { $0.domains as Any } ?? NSNull()]
default:
    break
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;
    appDir = mkdtempSync(join(tmpdir(), "sprint-board-source-"));
    process.on("exit", () => rmSync(appDir, { recursive: true, force: true }));
    writeFileSync(join(appDir, "main.swift"), driver);
    execFileSync("swiftc", [join(appDir, "main.swift"), "-o", join(appDir, "app")], { stdio: "pipe" });
    appDriver = join(appDir, "app");
  }
  return JSON.parse(execFileSync(appDriver, { input: JSON.stringify(input),
    env: { ...process.env, SB_CONFIG: join(appDir, "config.json"), ...env } }));
}

const HOSTS = [
  "##",
  "127.0.0.1\tlocalhost",
  "",
  "127.0.0.1 app.example.test",
  "#127.0.0.1 off.example.test",
  "",
].join("\n");
const GROUPS = [{ name: "Keep", domains: ["app.example.test", "off.example.test"] }];
const OLD_LIST = JSON.stringify({ domains: ["app.example.test", "off.example.test"], groups: GROUPS });

function hostsMessageRun(body, { list = JSON.stringify({ groups: GROUPS }), lockBackup = false, firstBackup = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sprint-board-source-message-"));
  const env = { SB_HOSTS: join(dir, "hosts"), SB_LIST: join(dir, "hosts.json"), SB_BACKUP: join(dir, "backup") };
  const backup = join(env.SB_BACKUP, "hosts.json.before-file-rows");
  mkdirSync(env.SB_BACKUP);
  writeFileSync(env.SB_HOSTS, HOSTS);
  writeFileSync(env.SB_LIST, list);
  if (firstBackup !== null) writeFileSync(backup, firstBackup);
  if (lockBackup) chmodSync(env.SB_BACKUP, 0o555);
  try {
    const { reply, refreshes } = appRun({ op: "hosts", body }, env);
    return { reply, refreshes, hosts: readFileSync(env.SB_HOSTS, "utf8"), list: readFileSync(env.SB_LIST, "utf8"),
      listBackup: existsSync(backup) ? readFileSync(backup, "utf8") : null };
  } finally {
    chmodSync(env.SB_BACKUP, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("window lights: each light carries its action as its identifier and targets widgetLightClicked", () => {
  const src = readFileSync(SWIFT_URL, "utf8");
  assert.match(src, /\(0xff5f57, "close"\), \(0xfebc2e, "minimize"\), \(0x28c840, "fill"\)\]\n\s*for \(i, light\) in lights\.enumerated\(\)/);
  assert.match(src, /button\.identifier = NSUserInterfaceItemIdentifier\(light\.action\)/);
  assert.match(src, /button\.target = self\n\s*button\.action = #selector\(widgetLightClicked\)/);
  assert.match(methodSource(src, "widgetLightClicked"), /windowAction\(button\.identifier\?\.rawValue \?\? ""\)/);
});

test("window lights: windowAction closes, minimises and fills", () => {
  const action = methodSource(readFileSync(SWIFT_URL, "utf8"), "windowAction");
  assert.match(action, /case "close": window\.orderOut\(nil\)/);
  assert.match(action, /case "minimize": window\.miniaturize\(nil\)/);
  assert.match(action, /case "fill": toggleFill\(\)/);
});

test("hostsList: a domains value of the wrong type makes the file unreadable", () => {
  assert.equal(appRun({ op: "list", json: { domains: 7, groups: [] } }).list, null);
  assert.equal(appRun({ op: "list", json: { domains: "x" } }).list, null);
  assert.deepEqual(appRun({ op: "list", json: { domains: ["a.example.test"], groups: [] } }).list, ["a.example.test"]);
});

test("Hosts migration: when the backup cannot be written the old list stays byte for byte and its groups still show", () => {
  const r = hostsMessageRun({ status: true }, { list: OLD_LIST, lockBackup: true });
  assert.equal(r.list, OLD_LIST);
  assert.equal(r.listBackup, null);
  assert.deepEqual(r.reply.groups, ["Keep"]);
});

test("Hosts migration: a later load keeps the first backup and still rewrites the old list to groups only", () => {
  const first = JSON.stringify({ domains: ["app.example.test"], groups: [] });
  const r = hostsMessageRun({ status: true }, { list: OLD_LIST, firstBackup: first });
  assert.equal(r.listBackup, first);
  assert.deepEqual(JSON.parse(r.list), { groups: GROUPS });
  assert.deepEqual(r.reply.groups, ["Keep"]);
});

test("Hosts message: setMode local makes the commented line active in place and the reply row local", () => {
  const r = hostsMessageRun({ setMode: "local", names: ["off.example.test"] });
  assert.equal(r.reply.error ?? null, null);
  assert.equal(r.hosts, HOSTS.replace("#127.0.0.1 off.example.test", "127.0.0.1 off.example.test"));
  assert.equal(r.reply.domains.find((d) => d.name === "off.example.test").local, true);
});

test("Hosts message: a switch and a Local delete refresh Chrome, an add and a Prod delete do not", () => {
  const cases = [
    [{ setMode: "local", names: ["off.example.test"] }, 1],
    [{ setMode: "prod", names: ["app.example.test"] }, 1],
    [{ remove: "app.example.test" }, 1],
    [{ add: "new.example.test" }, 0],
    [{ remove: "off.example.test" }, 0],
  ];
  for (const [body, refreshes] of cases) {
    const r = hostsMessageRun(body);
    assert.equal(r.reply.error ?? null, null);
    assert.notEqual(r.hosts, HOSTS, `${JSON.stringify(body)} writes the file`);
    assert.equal(r.refreshes, refreshes, JSON.stringify(body));
  }
});

test("fill mode: every widget page zooms to 1.4, returns to 1 and is told to fit again", () => {
  const src = readFileSync(SWIFT_URL, "utf8");
  const fill = methodSource(src, "toggleFill");
  const split = fill.indexOf("} else if let screen");
  assert.ok(split > 0);
  const [restore, grow] = [fill.slice(0, split), fill.slice(split)];
  for (const page of ["web", "hostsWeb", "widgetSettingsWeb"]) {
    assert.match(restore, new RegExp(`\\b${page}\\.pageZoom = 1\\n`));
    assert.match(grow, new RegExp(`\\b${page}\\.pageZoom = 1\\.4\\n`));
  }
  assert.match(fill, /for page in widgetPages \{\n\s*page\.evaluateJavaScript\("window\.sbFit && window\.sbFit\(\)"\)/);
  assert.match(src, /var widgetPages: \[WKWebView\] \{ \[web, hostsWeb, widgetSettingsWeb\] \}/);
});

test("board page: only the page WIDGET_BOARD_PAGE names, in web, sets boardLoaded and replays the data", () => {
  const src = readFileSync(SWIFT_URL, "utf8");
  const page = src.match(/^let WIDGET_BOARD_PAGE = "(.*)"$/m)[1].split("/").pop();
  const finish = methodSource(src, "webView");
  assert.match(finish, /didFinish nav: WKNavigation!/);
  const guard = `guard w === web, w.url?.lastPathComponent == "${page}" else { return }`;
  const order = [guard, "boardLoaded = true", "render(good, in: w)", "render(last, in: w)", "pushNotes()"].map((step) => finish.indexOf(step));
  assert.ok(order.every((at) => at >= 0), `steps of didFinish: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(finish, /if let good = lastOkJSON, good != lastJSON \{ render\(good, in: w\) \}/);
});

test("board page: loading a page into web clears boardLoaded, and a fetch result renders only while it is set", () => {
  const src = readFileSync(SWIFT_URL, "utf8");
  assert.match(methodSource(src, "loadPage"), /if target === web \{ boardLoaded = false \}/);
  assert.match(src, /if self\.boardLoaded \{ self\.render\(json, in: self\.web\) \}/);
  const renders = src.match(/^.*self\.render\(.*$/gm);
  assert.ok(renders.length > 0);
  assert.deepEqual(renders.filter((line) => !line.includes("self.boardLoaded")), []);
});

test("setup screen: a change of onSetupScreen runs layoutWidget on the main queue", () => {
  assert.match(readFileSync(SWIFT_URL, "utf8"),
    /var onSetupScreen = false \{\n\s*didSet \{ DispatchQueue\.main\.async \{ \[weak self\] in self\?\.layoutWidget\(\) \} \}\n\s*\}/);
});

test("setup screen: the header and tint hide there, and the page takes the header height where the header hides", () => {
  const layout = methodSource(readFileSync(SWIFT_URL, "utf8"), "layoutWidget");
  assert.match(layout, /let tabs = boardHeaderShown\(onSetupScreen: onSetupScreen, settingsShown: widgetSettingsShown, mode: displayMode\)\n/);
  assert.match(layout, /height: material\.bounds\.height - \(tabs \? PANEL_HEADER_HEIGHT : 0\)\)/);
  assert.match(layout, /header\.isHidden = !tabs\n/);
  assert.match(layout, /widgetTint\?\.isHidden = !tabs \|\| displayMode == \.popover\n/);
});

test("widget page scripts: the board page starts with hover off and can fit the window", () => {
  const launch = methodSource(readFileSync(SWIFT_URL, "utf8"), "applicationDidFinishLaunching");
  const config = launch.slice(launch.indexOf("let cfg = WKWebViewConfiguration()"), launch.indexOf("let frame = savedFrame()"));
  assert.match(config, /for source in \[PANEL_PAGE_SCRIPT, WIDGET_PAGE_SCRIPT\] \{/);
  assert.match(config, /cfg\.userContentController\.addUserScript\(WKUserScript\(\n\s*source: source, injectionTime: \.atDocumentStart, forMainFrameOnly: true\)\)/);
  assert.match(launch, /web = DragWebView\(frame: [^\n]*configuration: cfg\)/);
});

test("widget page scripts: the Hosts and Settings pages get the fit script before they load", () => {
  const tabs = methodSource(readFileSync(SWIFT_URL, "utf8"), "setUpWidgetTabs");
  const loop = tabs.match(/for page in \[([^\]]*)\] as \[WKWebView\] \{\n([\s\S]*?)\n {8}\}\n/);
  assert.ok(loop, "the tab page loop not found in setUpWidgetTabs");
  assert.deepEqual(loop[1].split(", "), ["hostsWeb", "widgetSettingsWeb"]);
  assert.match(loop[2], /page\.configuration\.userContentController\.addUserScript\(WKUserScript\(\n\s*source: WIDGET_PAGE_SCRIPT, injectionTime: \.atDocumentStart, forMainFrameOnly: true\)\)/);
  assert.match(tabs.slice(loop.index + loop[0].length), /loadPage\("popover\/hosts\.html", in: hostsWeb\)\n\s*loadPage\("popover\/settings\.html", in: widgetSettingsWeb\)/);
});

test("popover: opening on the Hosts tab asks for a fresh /etc/hosts status", () => {
  const open = methodSource(readFileSync(SWIFT_URL, "utf8"), "openPanel");
  assert.match(open, /\n\s*if widgetShownPage === hostsWeb \{ hostsMessage\(\["status": true\]\) \}\n/);
});

test("popover: a left click closes a shown popover and stops, and opens a closed one", () => {
  const toggle = methodSource(readFileSync(SWIFT_URL, "utf8"), "togglePanel");
  assert.match(toggle, /^\s*func togglePanel\(\) \{\n\s*if panel\.isShown \{ panel\.performClose\(nil\); return \}\n\s*openPanel\(\)\n\s*\}\n$/);
});

test("popover: closing puts nohover on the page that is on screen", () => {
  const close = methodSource(readFileSync(SWIFT_URL, "utf8"), "popoverWillClose");
  assert.match(close, /\n\s*widgetShownPage\.evaluateJavaScript\("document\.documentElement\.classList\.add\('nohover'\)"\)\n/);
});

test("popover: the open and close animation follows the reduce motion setting", () => {
  const setUp = methodSource(readFileSync(SWIFT_URL, "utf8"), "setUpPanel");
  assert.match(setUp, /\n\s*panel\.animates = !NSWorkspace\.shared\.accessibilityDisplayShouldReduceMotion\n/);
});

test("popover: only a left mouse-down on the status item's own window arms the reopen guard", () => {
  const close = methodSource(readFileSync(SWIFT_URL, "utf8"), "popoverWillClose");
  assert.match(close, /\n\s*if let event = NSApp\.currentEvent, event\.type == \.leftMouseDown,\n\s*event\.window != nil, event\.window === statusItem\.button\?\.window \{\n\s*panelClosedByIconAt = event\.timestamp\n\s*\}\n/);
});

test("popover: the size is fitted before the popover is shown", () => {
  const open = methodSource(readFileSync(SWIFT_URL, "utf8"), "openPanel");
  assert.match(open, /\n\s*fitPanel\(\)[^\n]*\n[\s\S]*\n\s*panel\.show\(relativeTo: button\.bounds, of: button, preferredEdge: \.minY\)\n/);
});

test("popover: the header height comes from whether the board header is shown", () => {
  const fit = methodSource(readFileSync(SWIFT_URL, "utf8"), "fitPanel");
  assert.match(fit, /\n\s*let tabs = boardHeaderShown\(onSetupScreen: onSetupScreen, settingsShown: widgetSettingsShown, mode: displayMode\)\n/);
  assert.match(fit, /header: tabs \? PANEL_HEADER_HEIGHT : 0,/);
});

test("popover: a needed sign-in opens the popover, and a closed widget stays closed", () => {
  const src = readFileSync(SWIFT_URL, "utf8");
  const closedPath = methodSource(src, "requireLogin").match(/if widgetClosed \{\n([\s\S]*?)\n\s*return\n/);
  assert.ok(closedPath, "requireLogin keeps a closed path");
  assert.match(closedPath[1], /if self\.displayMode == \.popover \{ self\.showHost\(\) \}$/);
  assert.doesNotMatch(closedPath[1], /window\.|^\s*self\.showHost\(\)/m);
  assert.ok(closedPath[1].indexOf('self.loadPage("setup.html")') < closedPath[1].indexOf("showHost"), "the setup page loads first");
});

test("popover: a failed sign-in opens the popover that holds the error", () => {
  const failed = methodSource(readFileSync(SWIFT_URL, "utf8"), "setupFailed");
  assert.match(failed, /DispatchQueue\.main\.async \{[\s\S]*sbSetupResult[\s\S]*\n\s*if self\.displayMode == \.popover \{ self\.showHost\(\) \}\n\s*\}\n/);
});

test("window lights: every button joins widgetLights, the list the switch to Popover mode hides", () => {
  const tabs = methodSource(readFileSync(SWIFT_URL, "utf8"), "setUpWidgetTabs");
  assert.match(tabs, /for \(i, light\) in lights\.enumerated\(\) \{[\s\S]*?header\.addSubview\(button\)\n\s*widgetLights\.append\(button\)\n\s*\}/);
});

test("popover: panelRoot is the view the popover shows", () => {
  const setUp = methodSource(readFileSync(SWIFT_URL, "utf8"), "setUpPanel");
  assert.match(setUp, /let content = NSViewController\(\)\n\s*content\.view = panelRoot\n\s*panel\.contentViewController = content\n/);
});

test("menu bar icon: the button's click goes to the app, set with its action", () => {
  const launch = methodSource(readFileSync(SWIFT_URL, "utf8"), "applicationDidFinishLaunching");
  assert.match(launch, /statusItem\.button\?\.target = self\n\s*statusItem\.button\?\.action = #selector\(statusItemClicked\)/);
});

test("popover: with no screen to measure, the fit assumes a height of 800", () => {
  const fit = methodSource(readFileSync(SWIFT_URL, "utf8"), "fitPanel");
  assert.match(fit, /panelContentHeight\([\s\S]*?screenHeight: screen\?\.visibleFrame\.height \?\? 800\)\)/);
});

test("popover: moveBoard leaves the views alone when the board is already on that host", () => {
  const move = methodSource(readFileSync(SWIFT_URL, "utf8"), "moveBoard");
  assert.match(move, /guard let header = widgetHeader, let tint = widgetTint, header\.superview !== host else \{ return \}\n\s*for view in/);
});
