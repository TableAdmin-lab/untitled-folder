// Login-flow test with live debug output.
//
// Runs ONLY the login portion of scrape.js, and after every step:
//   - saves a full-page screenshot to debug/live/step-NN-<name>.png
//   - updates debug/live/status.json (step list, state, timestamps)
//   - if LIVE_DEBUG_PUSH=1, commits + force-pushes debug/live to the
//     `debug-live` branch so debug.html can poll it in near-real-time.
//
// Env: YOCO_EMAIL, YOCO_PASSWORD, LIVE_DEBUG_PUSH (optional)

import { chromium } from "playwright";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_DIR = join(__dirname, "..", "debug", "live");
rmSync(LIVE_DIR, { recursive: true, force: true });
mkdirSync(LIVE_DIR, { recursive: true });

const EMAIL = process.env.YOCO_EMAIL;
const PASSWORD = process.env.YOCO_PASSWORD;
const PUSH = process.env.LIVE_DEBUG_PUSH === "1";

const status = {
  state: "running", // running | passed | failed
  startedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  steps: [], // { n, name, shot, at, ms }
};

let stepNo = 0;
let lastT = Date.now();

function publish() {
  writeFileSync(join(LIVE_DIR, "status.json"), JSON.stringify(status, null, 2));
  if (!PUSH) return;
  try {
    execSync(
      [
        "git add -A debug/live",
        `git -c user.name=login-test -c user.email=actions@github.com commit -m "debug: step ${stepNo}" --allow-empty -q`,
        "git push origin HEAD:refs/heads/debug-live --force -q",
      ].join(" && "),
      { cwd: join(__dirname, ".."), stdio: "inherit" }
    );
  } catch (e) {
    console.warn("live push failed:", e.message);
  }
}

async function step(page, name) {
  stepNo++;
  const shot = `step-${String(stepNo).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(LIVE_DIR, shot), fullPage: true }).catch(() => {});
  const now = Date.now();
  status.steps.push({ n: stepNo, name, shot, at: new Date(now).toISOString(), ms: now - lastT });
  lastT = now;
  console.log(`step ${stepNo}: ${name}`);
  publish();
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Missing YOCO_EMAIL / YOCO_PASSWORD environment variables.");
    process.exit(1);
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: LIVE_DIR, size: { width: 1440, height: 900 } },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  try {
    publish(); // step 0: announce the run so the viewer flips to "running"

    await page.goto("https://app.yoco.com/login/existing", { waitUntil: "networkidle" });
    await step(page, "login-page");

    await page.fill(
      'input[type="email"], input[autocomplete*="email"], input[name="email"]',
      EMAIL
    );
    await step(page, "email-filled");

    const pwField = 'input[type="password"]';
    if (!(await page.locator(pwField).count())) {
      await page.keyboard.press("Enter");
      await page.waitForSelector(pwField, { timeout: 20_000 });
      await step(page, "password-field-revealed");
    }
    await page.fill(pwField, PASSWORD);
    await step(page, "password-filled");

    await Promise.all([
      page.waitForURL((u) => !u.href.includes("/login"), { timeout: 60_000 }),
      page.keyboard.press("Enter"),
    ]);
    await page.waitForLoadState("networkidle").catch(() => {});
    await step(page, "logged-in");

    console.log("Login OK:", page.url());
    status.state = "passed";
  } catch (err) {
    status.state = "failed";
    status.error = String(err?.message || err);
    await step(page, "failure");
    throw err;
  } finally {
    status.finishedAt = new Date().toISOString();
    await ctx.close(); // flushes the video file into debug/live/
    await browser.close();
    publish();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
