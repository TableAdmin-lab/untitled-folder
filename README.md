# Yoco Pulse

A Yoco-inspired sales dashboard fed by a Playwright scraper that runs on GitHub Actions.

## How it works

```
index.html ──▶ Connect Yoco modal ──▶ GitHub Actions secrets
                 │                         ▲
                 └──▶ Vercel API ──────────┘
                                           │
.github/workflows/scrape.yml  (daily cron / manual)
                                           │
scraper/scrape.js  ──▶ Yoco Products report export
                                           │
data/latest.json  ──▶ index.html
```

- **`index.html`** — the dashboard. Shows demo data until `data/latest.json` exists, then switches to live scraper output.
- **`connect-config.js`** — public frontend config pointing the GitHub Pages site at the Vercel API URL.
- **`api/connect-yoco.js`** — Vercel serverless function. It receives the Yoco login over HTTPS, saves it as GitHub Actions secrets, and triggers `scrape.yml`.
- **`setup.html`** — redirects to the dashboard connection modal.
- **`scraper/scrape.js`** — Playwright login + Products report export, normalised into `data/latest.json`.
- **`scraper/login-test.js`** — isolated login-only test used by `test-login.yml`, publishes step-by-step screenshots for live debugging.
- **`.github/workflows/scrape.yml`** — runs daily at 06:00 SAST and on demand, commits the fresh JSON.
- **`.github/workflows/test-login.yml`** — on demand / on scraper changes, runs the login test and uploads screenshots + a session video as a build artifact.
- **`debug.html`** — side-by-side live view of the login test: agent screenshots on the left, step timeline on the right.

## Required automation secrets

| Secret | Used by | Value |
|---|---|---|
| `YOCO_EMAIL` | `scrape.yml`, `test-login.yml` | Your Yoco login email |
| `YOCO_PASSWORD` | `scrape.yml`, `test-login.yml` | Your Yoco login password |

No GitHub token is stored in the site. A GitHub token lives only in Vercel as a backend environment variable. The workflows themselves use the automatic, repo-scoped `GITHUB_TOKEN` that GitHub Actions injects into every run (see `permissions: contents: write` in each workflow) -- it is short-lived and never leaves Actions.

## Vercel backend environment

Set these in the Vercel project that deploys `api/connect-yoco.js`:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT or fine-grained token that can write Actions secrets and run workflows for this repo |
| `GITHUB_OWNER` | Repository owner / org |
| `GITHUB_REPO` | Repository name |
| `GITHUB_REF` | Branch to run, usually `main` |
| `GITHUB_WORKFLOW_FILE` | `scrape.yml` |
| `ALLOWED_ORIGIN` | Your GitHub Pages origin, for example `https://OWNER.github.io` |

## Setup

1. Push this repo to GitHub and enable **GitHub Pages** (Settings → Pages → deploy from `main`).
2. Deploy this repo, or at least the `api/` folder, to Vercel and set the backend environment variables above.
3. Update `connect-config.js` so `window.YOCO_CONNECT_ENDPOINT` points at your Vercel `/api/connect-yoco` URL.
4. Open the dashboard, choose **Connect Yoco**, enter the Yoco login, and wait while the backend starts the scraper.
5. The dashboard flips from "Demo data" to "Live" once `data/latest.json` lands.
6. To debug login issues: `gh workflow run test-login.yml`, then open `debug.html` on your Pages site to watch it run in near-real-time.

## Notes

- Yoco's portal is a SPA whose DOM changes over time; if login breaks, adjust the `SELECTORS` block at the top of `scraper/scrape.js`.
- If Yoco enforces 2FA/OTP on your account, headless login will need extra handling (e.g. an app password or session-cookie approach).
- Only scrape your **own** Yoco account, in line with Yoco's terms of service.
