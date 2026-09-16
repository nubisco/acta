---
name: run-acta
description: Launch and drive Acta to see a change working, locally in a real browser or on the live instance. Use when asked to run, start, screenshot or visually verify Acta, to check what build acta.nubisco.io is serving, or to measure reader and editor parity.
---

# Running Acta

Two different things are called "Acta", and they authenticate differently. Know
which one you mean before you start.

| | Live | Local |
| --- | --- | --- |
| Where | `https://acta.nubisco.io` | `http://localhost:<port>` |
| Runtime | Cloudflare Worker (`server/wrangler.toml`) | Bun (`server/src/index.ts`) |
| Database | D1 (`acta`) | SQLite in `ACTA_DATA_DIR` |
| Attachments | R2 (`acta-attachments`) | files in `ACTA_DATA_DIR` |
| Sign-in | **Nubisco Platform** (`platform.nubisco.io`) over SSO | email one-time code, printed to the server log |

The one-time code sign-in only exists because a local instance has no SSO
configured. **The live instance has no one-time codes.** Identity comes from
Platform, and the first person to sign in to a fresh workspace becomes its
admin. Never try to reach the live instance with the local recipe, and never
type a sign-in code or a password into a person's own browser: drive a separate
headless browser instead.

Configuration and the SSO contract are documented in
`docs/developers/configuration.md` and `docs/developers/authentication.md`.
Those are the source of truth. This skill is the working recipe.

## Is the live instance running my change?

Deploys are automatic. `.github/workflows/deploy.yml` runs after a successful
release on `master` and calls `wrangler deploy --var ACTA_BUILD_SHA:<sha>`, so
the live build is observable rather than assumed:

```sh
git fetch origin && git log --oneline -3 origin/master
curl -s https://acta.nubisco.io/healthz          # {"build":"<sha>", ...}
gh run list --workflow deploy.yml --limit 4
```

The `build` in `/healthz` is the release commit (the `chore(release)` one), not
the feature commit before it. A deploy run reported as `skipped` means the
release did not publish, so nothing new went out.

## Run it locally in a real browser

jsdom has no layout engine, so reflow, wrapping, sticky positioning and the CSS
Custom Highlight API are invisible to the test suite. This is how to see them.

All paths below are relative to the acta repository root.

### 1. Build, and copy the build somewhere of its own

```sh
S=$(mktemp -d)                                   # scratch for this run
(cd web && npx vite build) && cp -R web/dist "$S/web-dist" && rm -rf web/dist
```

Copy rather than point at `web/dist`: the pre-push hook and any later build
delete and rewrite it, which pulls files out from under a running server.

### 2. Start the server without SSO

```sh
cd server
ACTA_DATA_DIR="$S/data" ACTA_PORT=4799 ACTA_WEB_DIST="$S/web-dist" \
  ACTA_ADMIN_EMAIL=local@acta.test ACTA_ADMIN_HANDLE=local \
  ACTA_BASE_URL=http://localhost:4799 \
  nohup "$HOME/.bun/bin/bun" src/index.ts > "$S/server.log" 2>&1 &
cd ..
until curl -s -o /dev/null -w '%{http_code}' http://localhost:4799/ | grep -q 200; do sleep 1; done
```

- `bun` is not on `PATH` in every shell. Use `$HOME/.bun/bin/bun`.
- Leave every `ACTA_SSO_*` and `ACTA_OIDC_*` variable **unset**. With either
  configured, the server redirects to the provider before serving any HTML, and
  the one-time code endpoints return 404.
- `ACTA_ADMIN_*` is required here precisely because there is no provider to
  vouch for anyone.
- Pick a port nobody else is using. Several sessions run on these machines.

### 3. Sign in over the API

```sh
curl -s -X POST http://localhost:4799/api/v1/auth/otp \
  -H 'content-type: application/json' -d '{"email":"local@acta.test"}'
CODE=$(grep "OTP for local@acta.test" "$S/server.log" | tail -1 | awk '{print $NF}')
curl -s -c "$S/cookies.txt" -X POST http://localhost:4799/api/v1/auth/verify \
  -H 'content-type: application/json' \
  -d "{\"email\":\"local@acta.test\",\"code\":\"$CODE\"}"
```

`{"ok":true}` means the cookie jar now holds a session. Check it with
`curl -s -b "$S/cookies.txt" http://localhost:4799/api/v1/overview`.

### 4. Seed a document

```sh
curl -s -b "$S/cookies.txt" -X POST http://localhost:4799/api/v1/docs/write \
  -H 'content-type: application/json' \
  -d '{"ops":[{"op":"create","op_id":"seed-1","slug":"runbook","title":"Runbook","body":"# Overview\n\nText.","layout":"default","tags":[]}]}'
```

Anchored comments use the same endpoint:
`{"op":"comment","op_id":"...","ref":"runbook","body":"...","anchor":{"exact":"quoted text"}}`.

The workspace segment of every page URL is the workspace slug, which is
`nubisco` for `ACTA_WORKSPACE=Nubisco`. A document lives at
`/<workspace>/docs/<slug>`. Loading `/` redirects to the workspace, which is the
reliable way to learn it.

### 5. Drive a headless Chromium

Acta does not depend on Playwright, but the ui repository next to it does, with
browsers already cached:

```sh
PW=$(find ../ui/node_modules/.pnpm -path '*node_modules/playwright/index.mjs' | head -1)
```

Import that path in a Node script. Load the curl jar with `context.addCookies`:
it is Netscape format, so strip the `#HttpOnly_` prefix from a line before
splitting it on tabs.

Two things cover the page on a fresh account and a fresh browser, and will make
every click time out until they are dismissed:

- **The welcome dialog** (once per account): click `Skip for now`.
- **The product tour** (once per browser, remembered locally): click `Skip tour`.

Useful handles once the page is up: the `Edit` button, `Cancel`, `Save changes`,
`Cmd/Ctrl+S` to save while staying in the editor, the editor root `.ProseMirror`
(its `.editor` property is the Tiptap editor, so
`editor.storage.markdown.getMarkdown()` reads the document back), and
`page.on('requestfailed')` to name any failing request.

A `net::ERR_INCOMPLETE_CHUNKED_ENCODING` on `/events/stream` right after a
`page.goto` is the live-updates stream being cut by that navigation. It is not
a product error.

### 6. Reader and editor parity

`web/e2e/parity.mjs` measures every block in reader mode and edit mode and
exits 1 on any difference. Its header has the full recipe. With a seeded
document that uses every block type:

```sh
PLAYWRIGHT="$PW" node web/e2e/parity.mjs --base http://localhost:4799 \
  --cookies "$S/cookies.txt" --slug parity --out "$S/out" --width 1440 --height 900
```

Run each width as its own command. In zsh a variable holding `1440 900` is not
split into two arguments.

### 7. Clean up

```sh
kill "$(lsof -ti :4799)"
rm -rf "$S"
```

Stop every server you started before finishing.
