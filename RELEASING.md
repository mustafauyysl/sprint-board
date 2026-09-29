# Cutting a release

What comes out: `dist/SprintBoard.zip` (~70 MB). Whoever downloads it drops it into
`/Applications` and double-clicks; no warning, the setup screen greets them. No repo,
no node, no terminal.

## Prerequisites (once)

- A **Developer ID Application** certificate in the keychain
  (`security find-identity -v -p codesigning | grep "Developer ID"`)
- A **notarytool profile** (`xcrun notarytool history --keychain-profile sprint-board`)

If either is missing, the "Distribution build" section of `README.md` explains how to
set it up. Both require signing in to an Apple account and cannot be automated.

## Steps

**1. Everything must be clean and green**

```bash
node --test test.mjs
git status --porcelain          # must be empty
```

**2. Set the version with a tag** — `Info.plist` is derived from it, DO NOT WRITE IT BY HAND

```bash
git tag -a v1.1.0 -m "What changed"
```

Push the tag and the branch to the remote (with `--tags`). Publishing in this repo
goes through `push-gate`; if you are in an agent session, do not try to bypass that
gate.

**3. Build, sign, notarise, staple** — this UPLOADS to Apple and takes a few minutes

```bash
./build-app.sh --release
```

**4. Verify Gatekeeper** — you must see `accepted` and `Notarized Developer ID`

```bash
spctl -a -vvv "dist/Sprint Board.app"
```

**5. Publish the release**

```bash
gh release create v1.1.0 dist/SprintBoard.zip --title "v1.1.0" --notes "What changed"
```

## Testing it as if it were downloaded

The only way to see that notarisation actually works is to apply the quarantine stamp
by hand — a locally built `.app` never picks that stamp up, which makes normal testing
misleading:

```bash
rm -rf /tmp/dl && mkdir /tmp/dl && ditto -x -k dist/SprintBoard.zip /tmp/dl
xattr -w com.apple.quarantine "0083;00000000;Safari;" "/tmp/dl/Sprint Board.app"
spctl -a -vvv "/tmp/dl/Sprint Board.app"      # must say accepted
xcrun stapler validate "/tmp/dl/Sprint Board.app"
```

## How users find out

On every refresh (30 min) the widget checks `releases/latest`; if it is newer than the
user's own version, an **"⬆ vX.Y.Z is out — click to download"** row appears at the
bottom of the card, and clicking it opens the release page.

For that to work:

- The release must **NOT be a draft/prerelease** (`releases/latest` skips those)
- The tag must be in `vX.Y.Z` form
- The user's GitHub token must be able to see the repo (private repo → collaborator)

The app cannot update itself: the inside of a signed bundle cannot be modified. The
user downloads the new zip and drops it over the old one in `/Applications`.

## The version number

`build-app.sh` uses `git describe --tags --abbrev=0`. With no tag it writes `0.0.0`
and the app NEVER performs the update check — which is the desired behaviour in a
development build.
