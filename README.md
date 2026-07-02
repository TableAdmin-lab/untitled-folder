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
- **`setup.html`** — enter your Yoco email/password. They're encrypted in the browser with the repo's public key (libsodium sealed box) and stored as GitHub Actions secrets `YOCO_EMAIL` / `YOCO_PASSWORD`. Nothing is ever committed or stored locally.
- **`scraper/scrape.js`** — Playwright login + API-response capture, normalised into `data/latest.json`.
- **`.github/workflows/scrape.yml`** — runs daily at 06:00 SAST and on demand, commits the fresh JSON.

## Setup

1. Push this repo to GitHub and enable **GitHub Pages** (Settings → Pages → deploy from `main`).
2. Open `setup.html` on your Pages site and connect your Yoco account — or set secrets manually:
   ```sh
   gh secret set YOCO_EMAIL
   gh secret set YOCO_PASSWORD
   gh workflow run scrape.yml
   ```
3. The dashboard flips from "Demo data" to "Live" once `data/latest.json` lands.

## Notes

- Yoco's portal is a SPA whose DOM changes over time; if login breaks, adjust the `SELECTORS` block at the top of `scraper/scrape.js`.
- If Yoco enforces 2FA/OTP on your account, headless login will need extra handling (e.g. an app password or session-cookie approach).
- Only scrape your **own** Yoco account, in line with Yoco's terms of service.
