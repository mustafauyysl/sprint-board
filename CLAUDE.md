# Sprint Board — agent notes

A desktop sprint widget (macOS, Swift/AppKit + WKWebView + a Node data layer).
A personal tool, distributed to colleagues as a signed `.app`.

**Read this file, then read the "Notes learned the hard way" section of `README.md`.**
Every item there is a trap found by live measurement; do not try to fix them by guessing.
The release procedure lives separately in `RELEASING.md`.

## Start the session from the repo root

```bash
cd ~/.local/share/sprint-board && claude
```

A session opened from outside the repo root DOES NOT LOAD `.claude/settings.json`.
That file turns the `code-review`, `security-reviewer` and `test-coverage` plugins
off for this repo; without it the publishing step hits gates you cannot pass.

## Commands

| Command | What it does |
|---|---|
| `node --test test.mjs` | All tests. **Run after every change; do not call it done until green.** |
| `node fetch.mjs --demo` | Produces output from fake data without touching Jira |
| `node fetch.mjs` | Real data (~13 s, 8 API calls). Needs tokens on stdin — the app supplies them. |
| `./build-app.sh` | **Development** build → `/Applications`, reads the data layer FROM THE REPO |
| `./build-app.sh --release` | **Distribution** build → `dist/`. Read below. |

In a development build `view.html` / `fetch.mjs` / `lib.mjs` are read at runtime:
after editing them **no build is needed**, restarting the app is enough.
If Swift changes, `./build-app.sh`.

## Red lines

- **Do not run `--release` casually.** It **uploads the `.app` to Apple**
  (notarisation). Run it only when a release is genuinely being cut, following
  `RELEASING.md`.
- **DO NOT MODIFY the inside of a signed bundle.** A single file breaks the signature
  and macOS `SIGKILL`s the app (measured: `exit 137`). A change means re-signing.
- **Real data never enters the code.** A real Jira key, a real customer name, a real
  person's name, a real GitHub login — FORBIDDEN in the demo fixture and in the tests
  alike. Use invented ones (`DEMO-101`, `Ada Yilmaz`, `demo-user`). This was cleaned
  up once; do not put it back.
- **Tokens live in the keychain.** Never write them to any file or into any child
  process's `argv`. The app hands tokens to `fetch.mjs` through **stdin**.
- **The version is never written by hand.** `CFBundleShortVersionString` is derived
  from the git tag. Changing the version means cutting a new tag.
- **`lib.mjs` must stay pure.** No I/O, no `Date.now()` — `now` is always a parameter.
  New logic goes here plus its test in `test.mjs`. I/O goes in `fetch.mjs`.

## Jira authentication — why the Worker exists

The goal: the user types nothing and just presses "Sign in with Atlassian".

**Atlassian DOES NOT SUPPORT public clients.** The identity server advertises only
`client_secret_basic` and `client_secret_post` in
`token_endpoint_auth_methods_supported` — there is no `none`. PKCE is supported, but
ALONGSIDE the secret, not INSTEAD of it. Measured: a token request without the secret
returns `401 access_denied`. Tracking: ECO-283, "Gathering Interest".

The secret cannot go into the distributed `.app` — the `.mjs` files inside the zip
are plain text and the repo is public. That is why `worker/` exists: its only job is
to add the secret and forward the request to Atlassian. It keeps no state and logs
nothing.

- Worker: `https://sprint-board-auth.mustafa-uysal.workers.dev`
  (`/token`, `/refresh`, `/health`)
- The client ID stays in the code / `wrangler.toml` — it is not a secret.
- **The client secret lives ONLY in Cloudflare** (`wrangler secret put`). NEVER in
  the repo.
- Deploy: `cd worker && npx wrangler deploy`

**Token lifetime:** access lasts 1 hour (refreshed silently in the background, no
browser opens), refresh is rotating and expires after 90 days of inactivity — every
refresh resets those 90 days. So as long as the app is opened, the session is
permanent.
**The rotating-token trap:** the new refresh token must be SAVED BEFORE IT IS USED;
if that order breaks, the chain snaps and the user has to sign in again.

**Why the API-token route is not enough:** since December 2024 Atlassian caps API
token lifetime at 1 year with no non-expiring option. On that route every user would
have to renew a token by hand once a year.

Verified end to end (2026-09-23): token from the Worker HTTP 200 · sites come from
`accessible-resources` · the email comes from `/me` · a real sprint query through
`api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...` HTTP 200 · refresh HTTP 200
without the browser opening.

The Swift side (sign-in screen, local callback listener, token storage) and the
Bearer + cloudId path in `fetch.mjs`'s Jira layer are implemented. The Basic-auth
path still works for older installs.

## Architecture

| File | Role |
|---|---|
| `SprintBoard.swift` | NSWindow + WKWebView, menu bar, keychain, JS bridge |
| `view.html` | The board screen (plain JS, no framework, NOT an ES module) |
| `setup.html` | First-launch setup screen |
| `fetch.mjs` | I/O: Jira REST + GitHub GraphQL + keychain + sound |
| `lib.mjs` | Pure logic, zero I/O |
| `test.mjs` | `node --test`, zero dependencies |

Config lives at `~/.config/sprint-widget/config.json`, state at
`~/.local/state/sprint-widget/`. Both are OUTSIDE the repo folder; do not write there.

## Frequent mistakes

- **SIGPIPE KILLS the app.** Tokens go to fetch.mjs over stdin; if the child exits
  early with an error, the read end of the pipe closes and the write kills the
  process (measured: `exit 141` = 128+13). `signal(SIGPIPE, SIG_IGN)` is called at
  startup — do not remove it. The symptom is insidious: the widget shows an error
  first, then silently disappears.
- **Prepare the data going to the child BEFORE `p.run()`.** In OAuth mode
  `tokenPayload()` can make a network request; if it is prepared afterwards,
  fetch.mjs reads the empty pipe in the meantime and carries on without a token.
- **`readFileSync(0)` is not reliable on a pipe** — if the pipe is still empty it
  throws EAGAIN and looks like "no data". stdin must be read as a stream until EOF.
- **Do not test with a fake `HOME`.** It works for the config files, but because
  macOS looks for the login keychain under `$HOME/Library/Keychains/` a "Keychain Not
  Found" dialog appears. Tests that touch the keychain must run with the real HOME
  (back up the config first).

- `view.html`/`setup.html` cannot import ES modules (`file://` origin). Write plain JS.
- `set -o pipefail` is on: `$(git ... | sed ...)` returns 128 when there is no tag and
  silently kills the script. Use `|| true` in places like that.
- Data refresh must not run while the setup screen is open (the `onSetupScreen` flag).
- **Compare the PID** after a build; if the old process is still up the new binary
  never runs and the thing you "fixed" is not running at all.
