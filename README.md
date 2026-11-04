# Sprint Board

A native macOS sprint tracking widget that sits on your desktop. Your own
Jira tasks in the open sprint, the **business days each one has spent in its status**,
the one furthest past its threshold shown as **Most overdue**, and PR/CI state.

The widget has two tabs: **Sprint** (the board) and **Hosts** (switches domains between
this Mac and production through `/etc/hosts`).

A personal tool — not owned by any company, not designed to be distributed.

## Why it exists

"Which task is in which status" is already in Jira. What gets lost is **how long a
piece of work has been stuck in one status** — that data is not on the board view,
it can only be derived from the changelog.

## Architecture

| File | Role |
|---|---|
| `SprintBoard.swift` | NSWindow + WKWebView, widget tabs, menu bar menu, dragging, JS bridge, `/etc/hosts` |
| `setup.html` | The sign-in screen; also shown when macOS refuses the token read |
| `popover/sprints.html` | The widget's Sprint tab (plain JS, no framework) |
| `popover/settings.html` | Settings over the widget's tabs, behind a back arrow |
| `popover/hosts.html` | The widget's Hosts tab |
| `app.entitlements` | Lets the signed app send Apple Events to Chrome (after a Hosts switch) |
| `fetch.mjs` | I/O: Jira REST + GitHub GraphQL + keychain + sound |
| `lib.mjs` | Pure logic — no I/O, no `Date.now()` (`now` is passed in) |
| `test.mjs` | `node --test`, zero dependencies |
| `build-app.sh` | Build → `/Applications/Sprint Board.app` → restart |

Deliberately kept **outside** the code folder:

- `~/.config/sprint-widget/config.json` — settings (see `config.example.json`)
- `~/.local/state/sprint-widget/` — `state.json` (the last seen most overdue task / broken CI /
  review record, which is what stops a sound repeating) + `notes.json`, and the Hosts tab's
  backups: `hosts.bak` before every write to `/etc/hosts`, `hosts.before-sprint-board` once,
  and `hosts.json.before-file-rows`, a copy of an old `hosts.json` taken before its migration
- `~/.config/sprint-widget/hosts.json` — the Hosts tab's groups, nothing else. The domains and
  their Local or Prod state are read from `/etc/hosts` on every load.
- Jira token — **keychain**, service `sprint-board-jira` (overridable in config)
- GitHub token — **keychain**, service `sprint-board-github`. Without one it falls
  back to `gh auth token`, so if `gh` is installed there is nothing extra to do.

No token is ever stored in plain text in a file.

**First launch:** with no config, or no Jira token in the keychain, the app opens
`setup.html` instead of the board; you sign in with Atlassian there, the config is
written and the tokens go into the keychain. Settings open later from the gear button, or
from the ring icon in the menu bar → **Settings…**, over the widget's tabs.

When "Sign in with Atlassian" is not available (for example while the Atlassian app is
still in development mode, which only lets its owner sign in), **Use an API token
instead** takes a Jira site, email and API token. The token is checked against
`/rest/api/3/myself`, then stored by the app itself under the keychain service
`sprint-board-jira-token`, so reading it back opens no permission dialog. Opened from
Settings while signed in, the screen shows the connected account, **Back to board**,
and **Disconnect** (two clicks; removes the stored token or refresh token and the
identity from the config, keeps thresholds, sounds and notes).

## Installation

```bash
gh repo clone mustafauyysl/sprint-board ~/.local/share/sprint-board
~/.local/share/sprint-board/install.sh
```

`install.sh` verifies the prerequisites, fetches the code, creates the settings file,
runs the tests, builds and installs it as `/Applications/Sprint Board.app`.
To update, run the same command again (`git pull --ff-only` + rebuild).

Required: **Xcode Command Line Tools** (`xcode-select --install`), **node**, **gh**
(with `gh auth login` already done). Your Jira identity is not entered by hand — the
app's own setup screen fills it in after you sign in with Atlassian.

### Distribution build

```bash
./build-app.sh --release
```

Copies the data layer (`fetch.mjs`, `lib.mjs`, the pages and `popover/`) **inside** the
bundle — so whoever downloads it never has to clone the repo — signs with Developer ID
(with `app.entitlements`), notarises, staples, and produces `dist/SprintBoard.zip`.

The resulting `.app` is **self-contained**: both the data layer and Node (v24.21.0,
downloaded from the official distribution with its checksum verified) live inside it.
Whoever downloads it needs no repo, no node and no Homebrew.

The binary and Node are universal (arm64 + x86_64) → it opens on every Mac. The
bundle is ~191 MB, the downloaded zip ~80 MB (for comparison: Slack 551 MB, VS Code
1.4 GB — small for this class). If you only ship to Apple Silicon,
`ARCHS=arm64 ./build-app.sh --release` halves the size; that build
**will not open on an Intel Mac**.

Node is shrunk with `strip -x` (236 → 190 MB). Because that breaks Node's own Apple
signature, re-signing immediately afterwards is **mandatory** — otherwise macOS
SIGKILLs the binary the moment it starts. `--release` does this, and verifies it by
running the embedded node once after signing.

Prerequisites: a **Developer ID Application** certificate (a paid Apple Developer
Program membership) and a notarytool profile:

```bash
xcrun notarytool store-credentials "sprint-board" \
  --apple-id <apple-id> --team-id <team-id> --password <app-specific-password>
```

### Why we do not ship a prebuilt ad-hoc signed `.app`

macOS stamps `com.apple.quarantine` on every **downloaded** file, and Gatekeeper
rejects an ad-hoc signed app (`spctl -a` → `rejected`). Shipping a prebuilt binary
would force every user to click "Open Anyway" by hand in System Settings — or
require notarisation through an Apple Developer Program membership. A binary built
**locally** never picks up quarantine at all, so installing from source removes both
costs.

## Usage

- Click the **ring icon** (a circle with a check) in the menu bar for refresh / bring widget
  to front / settings / show in Dock / quit. A left click and a right click do the same
- The app is not in the Dock or Cmd+Tab (macOS ties the two together). **Ring icon → Show in
  Dock** adds both; click it again to remove them. The choice is remembered across launches
- Drag by the **tab header**. The three dots on it close the widget (the app keeps running; ring icon → Bring widget to front
  brings it back, as do the Dock icon and Cmd+Tab when it is in the Dock), minimise it,
  or make it fill the screen with larger text
- At the top right of the Sprint tab, the **refresh** button refreshes and the
  **settings** (gear) button opens Settings. **GitHub organization** limits the PR
  searches (your PRs and the reviews you are asked for) to one organization; empty
  means all PRs. Only a valid GitHub organization name is saved, and the board uses it
  at the next refresh. An invalid name typed into the config by hand turns the PR
  bands off with a message; it never widens the search to all PRs
- **Team sprint goal** (off by default; turn on **Sprint goal tracking** in Settings) is the
  second card. It lists the flagged tasks of your active sprint, whoever owns
  them, with done/total. A task counts as done when its status category is done. An open
  goal task's colour depends on its stage (the board column its status sits in) and the
  sprint's business days left: each stage turns yellow (at risk) and red (critical) in its own
  last N days, e.g. UAT is yellow in the last 3 days and red on the last day, In Progress
  yellow in the last 5 and red in the last 3. The sprint's last day is the day before Jira's
  end date (a sprint that starts on a Thursday ends on the Wednesday). A status no stage lists
  counts as In Progress. `goalRiskStages` in the config replaces the stage list (defaults in
  `lib.mjs`). The header takes the worst colour. Your own tasks that are
  also goal tasks carry a "GOAL" mark. The warning is on the board only; there is no
  notification. With the setting off the app makes no extra Jira call
- Refresh runs every 30 minutes and takes ~13 s
- **Merge blocked** lists the PRs that cannot be merged, each with its reasons:
  conflicts first, then failing required checks, then changes requested. A PR whose
  merge state GitHub has not settled shows as "checking". Every PR the search returns
  counts; a Jira key in the title is not needed (the **GitHub organization** setting
  scopes the search). A key in the title still links the PR to its task: it shows in
  the task row's PR column. Drafts count and are marked "draft" while **Show draft PRs** (Settings, on
  by default) is on; the Waiting band never shows drafts. A PR in this band that starts conflicting sends
  a macOS notification (click opens the PR); a refresh you trigger (Refresh now or the refresh button)
  always reports its result for the same PRs: "No conflicts, no CI errors" or which
  PRs have a conflict or a failing required check

### The tabs

The widget keeps the selected tab across launches, and the window follows the height of the
page on screen. A fold moves the window edge with the same time and curve as the content.

- **Sprint**: refresh and settings sit at the top right (hover the refresh button to see how
  old the data is), three cards show the sprint, the team goal and the days left (click the
  team goal card to open its tasks), and every status folds (finished and cancelled ones
  start folded). GitHub has three sections: Waiting For Review, Awaiting Your Review, Merge Blocked.
  A merged PR's number carries a merge mark and a deployed one a globe; a task's age is in
  its day count's tooltip
- **The gear** (on the Sprint and Hosts tabs) opens Settings over the tabs, with a back
  arrow to the tab it came from: Disconnect, GitHub organization, drafts, goal tracking and
  partner domains. **Settings…** in the menu opens the same page. With no sign-in, both open
  the sign-in screen
- **Hosts** manages `/etc/hosts` directly, like iHosts. The file is the source of truth: each
  local domain in it is a row, wherever its line is, and there is no copied list. An active
  line is **Local**. A line kept as a comment is **Prod**. A switch keeps the line in its place
  and changes no other line. On a line with several domains, the switched domain moves to a new
  line right below, and the other domains stay as they are. A comment is a Prod row only when
  it is clearly a host entry: one `#`, `127.0.0.1` or `::1`, then only host names. `localhost`,
  `broadcasthost` and the other system lines are never shown or changed. Group chips filter the
  list; **All local** and **All prod** switch every domain shown. **+** adds domains (several at
  once: `a.com,b.com`; URLs work too), a partner, or a group. A new domain goes into Sprint
  Board's block, between `# >>> extension manages >>>` and `# <<< extension manages <<<`, and
  starts in Prod. The trash icon on a row removes that domain from every line it is on, in the
  block or outside it. The other domains and the trailing comment stay, and the last domain on
  a line takes the line. The app never asks for an admin password: your user must be able to write
  `/etc/hosts`, otherwise the tab says so and changes nothing
- **Add partner** appears once Settings → **Partner domains** lists the domain endings a
  partner's environment answers on, separated by commas, e.g. `panel.example.com,
  api.example.com` (saved as `partnerDomainSuffixes` in the config). A partner name then adds
  `<partner>.panel.example.com` and `<partner>.api.example.com` to a Partners group. The
  list is empty by default
- **After a switch** the app asks every open Chrome window to drop its DNS cache and open
  connections, so pages follow the new address at once. That needs Chrome started with
  `--enable-net-benchmarking` and, in each profile, View › Developer › Allow JavaScript from
  Apple Events; the first time, macOS asks whether Sprint Board may control Chrome. When
  something is missing the Hosts tab says what. The **Open Insecure Chrome** button (left of
  search) starts a closed Chrome with `--ignore-certificate-errors --allow-insecure-localhost
  --enable-net-benchmarking`; a Chrome already running without them is left alone, with a
  note to quit it (⌘Q) and press the button again

`setup.html` / `popover/` / `fetch.mjs` / `lib.mjs` are read at runtime → after
editing them **no build is needed**, restarting the app is enough. If Swift changes, `./build-app.sh`.

## Notes learned the hard way

- **`statuscategorychangedate` is unusable.** It does not reset on transitions within
  a category (In Progress → In Code Review, both `indeterminate`). Durations come
  from the changelog.
- **The clock belongs to the PERSON, not the ticket.** A card that sat unassigned in
  To Do for 23 days and was handed over today is 1 day of that person's delay, not
  23 — otherwise it lands on its new owner as an instant overdue alert for a queue they
  never saw. Time-in-status is measured from the later of the status change, the
  assignment to that person, and entry into the current sprint (`ownershipStartedAt`).
  Sprint membership in the changelog is a COMMA-SEPARATED id list, so an id must be
  in `to` and NOT in `from` to count as an actual entry.
- **`statusCheckRollup.state` is unusable** — it counts optional checks too and
  produces false "CI broken" alarms. Use `isRequired(pullRequestNumber:)` per check.
- **Re-run check duplication:** GitHub keeps both the old and the new run of the same
  check (CANCELLED + SUCCESS). Only the latest run may count.
- **The done category ≠ finished.** This Jira has 15 statuses in the done category.
  The distinction is drawn with an **allow list** (`pendingReleaseStatuses`): what is
  on the list is "waiting to ship", EVERYTHING ELSE counts as finished. The inverse
  was tried and was wrong — a "finished" list showed every unrecognised status as
  "waiting" forever (Closed, Resolved, Problem Solved, Epic is Done, Question and
  Unresolved, all six at once). An unknown status fails closed.
  For the same reason "finished" never proves a release: a merged PR reads **deployed**
  only when its task's status is on a second allow list (`releasedStatuses`, default
  `Released on Prod`) or its merge commit is already on `master`.
- **`searchIssues` cuts off at maxResults=100 and DOES NOT PAGINATE.** Filtering a
  broad JQL on the client means silent data loss; move the filter into the JQL. The
  pending-release query is also sorted `updated ASC` — the stalest items are the
  entire reason that band exists.
- **`mergeable: UNKNOWN` is not a conflict** — GitHub computes it lazily and returns
  `MERGEABLE` on a second query. Only `CONFLICTING` counts as a blocker.
- **A merge can be blocked while CI is green:** `reviewDecision: REVIEW_REQUIRED`.
- **`node` and `gh` are not looked up on PATH.** A GUI app launched from Finder does
  not see the shell PATH, and Homebrew lives under `/opt/homebrew` on Apple Silicon
  and `/usr/local` on Intel. Both are resolved from a candidate list
  (`resolveExecutable`).
- **The code folder's path is not baked into Swift** — `build-app.sh` writes it into
  the bundle as `Contents/Resources/appdir`, so the clone can live anywhere.
- **An invalid Jira token DOES NOT ERROR on search.** Jira treats an invalid identity
  as anonymous and returns `HTTP 200 + {"issues":[]}` (the same token gets 401 on
  `/myself`). Someone who entered a wrong token therefore saw a blank board, not an
  error. The identity is now verified when the result is empty — a populated board
  costs no extra request.
- **Whichever app WRITES a keychain item must READ it.** If the app tries to read an
  item created by the `security` command, macOS opens a permission window (measured:
  the command hung waiting on the dialog). So the items the setup screen writes are
  marked with a `tokensOwnedByApp` flag, and the app reads only those and passes them
  to fetch.mjs **through stdin** (argv shows up in `ps` output). For older,
  hand-made items the app never touches the keychain.
- **The sprint field's id varies per installation** — the common assumption is
  `customfield_10020`, but it can differ in every Jira. So it is discovered at
  runtime via `/rest/api/3/field` and written into the config; it is hard-coded
  nowhere.
- **If the `security` command's stderr mixes into stdout, JSON parsing blows up** →
  `stdio: ["ignore", "pipe", "ignore"]`.
- **WKWebView `isFlipped == true`** — y counts from the top.
- **An unconditional `performDrag` on the drag strip kills every button on that
  strip.** Telling a click from a drag in `mouseDown` is mandatory.
- **`evaluateJavaScript(..., completionHandler: nil)` swallows the error.** The page
  was stuck on "loading" and left no trace at all.
- **An app launched with `open` does not reach the unified log with NSLog** — write
  to a file for diagnosis.
- **No main menu means no Cmd+C / Cmd+V / Cmd+A.** macOS routes those shortcuts through
  the Edit menu's key equivalents; an app built in code has none, so a pasted token never
  reached the setup inputs. `buildMainMenu()` adds one.
- **A missed notification prompt counts as "Don't Allow".** The first-launch request
  then fails with "Notifications are not allowed for this application" on every run;
  the switch is in System Settings → Notifications → Sprint Board.
- **`/etc/hosts` is written in place.** A user who owns the file still cannot create files
  in `/etc`, so temp-file-and-rename is impossible; writing in place also keeps its owner and
  mode as they were.
- **Chrome does not follow an `/etc/hosts` change.** It keeps its own host cache and reuses
  pooled connections (HTTP/2, QUIC, keep-alive) until the network changes.
  `chrome.benchmarking.clearHostResolverCache()` and `closeConnections()` drop them and keep
  cookies; they exist only when Chrome was started with `--enable-net-benchmarking`. Killing
  Chrome's network service works too, but loses session cookies: do not.
- **Cloudflare WARP reads `/etc/hosts` once, when it connects.** A name removed from the
  file keeps resolving to 127.0.0.1 until `warp-cli disconnect && warp-cli connect`.
- **The hardened runtime refuses Apple Events without the entitlement** (error -1743) and
  never shows the permission prompt; hence `app.entitlements`. The ad-hoc signed development
  build is not affected, so only a signed build shows it.
- **A hidden WKWebView keeps the last mouse position it saw.** Shown again, it draws that
  element as hovered until the mouse moves: after a page swap the button under the pointer
  lit up. Tab pages start with a `nohover` class that the first real mouse move removes.

## Licence

Personal use.
