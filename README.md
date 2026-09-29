# Sprint Board

A retro-RPG-themed sprint tracking widget that sits on your macOS desktop. Your own
Jira tasks in the open sprint, the **business days each one has spent in its status**,
whichever one exceeds its threshold flashing as the BOSS, and PR/CI state.

A personal tool — not owned by any company, not designed to be distributed.

## Why it exists

"Which task is in which status" is already in Jira. What gets lost is **how long a
piece of work has been stuck in one status** — that data is not on the board view,
it can only be derived from the changelog.

## Architecture

| File | Role |
|---|---|
| `SprintBoard.swift` | NSWindow + WKWebView, menu bar, dragging, JS bridge |
| `view.html` | The visual layer (plain JS, no framework) |
| `setup.html` | First-launch setup screen |
| `fetch.mjs` | I/O: Jira REST + GitHub GraphQL + keychain + sound |
| `lib.mjs` | Pure logic — no I/O, no `Date.now()` (`now` is passed in) |
| `test.mjs` | `node --test`, zero dependencies |
| `build-app.sh` | Build → `/Applications/Sprint Board.app` → restart |

Deliberately kept **outside** the code folder:

- `~/.config/sprint-widget/config.json` — settings (see `config.example.json`)
- `~/.local/state/sprint-widget/` — `state.json` (the last seen boss / broken CI /
  review record, which is what stops a sound repeating) + `notes.json`
- Jira token — **keychain**, service `sprint-board-jira` (overridable in config)
- GitHub token — **keychain**, service `sprint-board-github`. Without one it falls
  back to `gh auth token`, so if `gh` is installed there is nothing extra to do.

No token is ever stored in plain text in a file.

**First launch:** with no config, or no Jira token in the keychain, the app opens
`setup.html` instead of `view.html`; you sign in with Atlassian there, the config is
written and the tokens go into the keychain. It can be reopened later from
**⚔ → Settings…** in the menu bar.

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

Copies the data layer (`fetch.mjs`, `lib.mjs`, `view.html`) **inside** the bundle —
so whoever downloads it never has to clone the repo — signs with Developer ID,
notarises, staples, and produces `dist/SprintBoard.zip`.

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

- **⚔** in the menu bar → refresh / bring to front / quit (no Dock icon, `LSUIElement`)
- Drag by the card's **top strip**; the **⟳** on that same strip refreshes
- Refresh runs every 30 minutes and takes ~13 s

`view.html` / `fetch.mjs` / `lib.mjs` are read at runtime → after editing them **no
build is needed**, restarting the app is enough. If Swift changes, `./build-app.sh`.

## Notes learned the hard way

- **`statuscategorychangedate` is unusable.** It does not reset on transitions within
  a category (In Progress → In Code Review, both `indeterminate`). Durations come
  from the changelog.
- **The clock belongs to the PERSON, not the ticket.** A card that sat unassigned in
  To Do for 23 days and was handed over today is 1 day of that person's delay, not
  23 — otherwise it lands on its new owner as an instant boss alert for a queue they
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

## Licence

Personal use.
