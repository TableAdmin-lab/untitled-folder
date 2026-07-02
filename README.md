# ⚡ Yoco Pulse

A Yoco-inspired sales dashboard, fed by a Playwright scraper that runs on GitHub Actions.

## How it works

```
setup.html ──(encrypted secrets)──▶ GitHub Actions secrets
                                        │
.github/workflows/scrape.yml  (daily cron / manual)
                                        │
scraper/scrape.js  — Playwright logs into portal.yoco.co.za,
                     captures the portal's own API responses
                                        │
data/latest.json  ──▶  index.html (the dashboard)
```

- **`index.html`** — the dashboard. Shows demo data until a scrape has run, then switches to live data automatically.
- **`setup.html`** — instructions for setting the required GitHub Actions secrets. Does **not** ask for a GitHub token; secrets are set from the CLI or the repo's Settings UI, never through a web page.
- **`scraper/scrape.js`** — Playwright login + API-response capture, normalised into `data/latest.json`.
- **`scraper/login-test.js`** — isolated login-only test used by `test-login.yml`, publishes step-by-step screenshots for live debugging.
- **`.github/workflows/scrape.yml`** — runs daily at 06:00 SAST and on demand, commits the fresh JSON.
- **`.github/workflows/test-login.yml`** — on demand / on scraper changes, runs the login test and uploads screenshots + a session video as a build artifact.
- **`debug.html`** — side-by-side live view of the login test: agent screenshots on the left (with a loading spinner while a step is in flight), step timeline on the right. Requires the repo to be public (see Setup).

## Required secrets

| Secret | Used by | Value |
|---|---|---|
| `YOCO_EMAIL` | `scrape.yml`, `test-login.yml` | Your Yoco login email |
| `YOCO_PASSWORD` | `scrape.yml`, `test-login.yml` | Your Yoco login password |

No GitHub token needs to be created. Both workflows use the automatic, repo-scoped `GITHUB_TOKEN` that GitHub Actions injects into every run (see `permissions: contents: write` in each workflow) — it's short-lived and never leaves Actions.

## Setup

1. Push this repo to GitHub and enable **GitHub Pages** (Settings → Pages → deploy from `main`).
2. Set the two secrets above:
   ```sh
   gh secret set YOCO_EMAIL
   gh secret set YOCO_PASSWORD
   gh workflow run scrape.yml
   ```
   (or Settings → Secrets and variables → Actions → New repository secret)
3. The dashboard flips from "Demo data" to "Live" once `data/latest.json` lands.
4. To debug login issues: `gh workflow run test-login.yml`, then open `debug.html` on your Pages site to watch it run in near-real-time.

## Notes

- Yoco's portal is a SPA whose DOM changes over time; if login breaks, adjust the `SELECTORS` block at the top of `scraper/scrape.js`.
- If Yoco enforces 2FA/OTP on your account, headless login will need extra handling (e.g. an app password or session-cookie approach).
- Only scrape your **own** Yoco account, in line with Yoco's terms of service.
