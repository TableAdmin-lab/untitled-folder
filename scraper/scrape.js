// Yoco products-report scraper.
//
// Flow:
//   1. Log in at https://app.yoco.com/login/existing
//   2. Open the Products report
//   3. Filter to the Mon/Wed/Fri reporting window:
//        - Monday run    → past Friday, Saturday & Sunday
//        - Wednesday run → past Monday & Tuesday
//        - Friday run    → past Wednesday & Thursday
//      (run on any other day → uses the most recent report day's window)
//   4. Click the download (top-right) button → "Excel" → save the .xlsx
//   5. Parse the xlsx into ../data/latest.json for the dashboard
//
// Env: YOCO_EMAIL, YOCO_PASSWORD (GitHub Actions secrets)
// Debug: writes screenshots to ../debug/ at each step so failures are diagnosable.

import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { writeFileSync, mkdirSync, copyFileSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DEBUG_DIR = join(__dirname, "..", "debug");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(DEBUG_DIR, { recursive: true });

const EMAIL = process.env.YOCO_EMAIL;
const PASSWORD = process.env.YOCO_PASSWORD;

/* ---------------- report window (SAST) ---------------- */

function sastToday() {
  // GitHub runners are UTC; South Africa is UTC+2, no DST.
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

// Returns {start, end, reportDay} as Date objects (inclusive range).
export function reportWindow(today = sastToday()) {
  const dow = today.getUTCDay(); // 0=Sun … 6=Sat
  // Most recent report day (Mon=1, Wed=3, Fri=5) on or before today.
  const reportDays = [1, 3, 5];
  let back = 0;
  while (!reportDays.includes((dow - back + 70) % 7)) back++;
  const reportDay = addDays(today, -back);
  const rdow = reportDay.getUTCDay();

  if (rdow === 1) return { reportDay, start: addDays(reportDay, -3), end: addDays(reportDay, -1) }; // Fri–Sun
  if (rdow === 3) return { reportDay, start: addDays(reportDay, -2), end: addDays(reportDay, -1) }; // Mon–Tue
  /* rdow === 5 */ return { reportDay, start: addDays(reportDay, -2), end: addDays(reportDay, -1) }; // Wed–Thu
}

/* ---------------- scraping ---------------- */

const shot = (page, name) =>
  page.screenshot({ path: join(DEBUG_DIR, `${name}.png`), fullPage: true }).catch(() => {});

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error("Missing YOCO_EMAIL / YOCO_PASSWORD environment variables.");
    process.exit(1);
  }
  const { start, end, reportDay } = reportWindow();
  console.log(
    `Report day ${ymd(reportDay)} → window ${ymd(start)} .. ${ymd(end)} (inclusive)`
  );

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  try {
    /* ---- 1. login ---- */
    console.log("Logging in…");
    await page.goto("https://app.yoco.com/login/existing", { waitUntil: "networkidle" });
    await shot(page, "01-login");
    await page.fill('input[type="email"], input[autocomplete*="email"], input[name="email"]', EMAIL);
    // Some flows reveal the password field after the email step.
    const pwField = 'input[type="password"]';
    if (!(await page.locator(pwField).count())) {
      await page.keyboard.press("Enter");
      await page.waitForSelector(pwField, { timeout: 20_000 });
    }
    await page.fill(pwField, PASSWORD);
    await shot(page, "02-credentials");
    await Promise.all([
      page.waitForURL((u) => !u.href.includes("/login"), { timeout: 60_000 }),
      page.keyboard.press("Enter"),
    ]);
    console.log("Logged in:", page.url());
    await shot(page, "03-logged-in");

    /* ---- 2. products report ---- */
    // Guessed query-string params (period=custom&startDate=...) made Yoco's
    // own SPA choke and show a "can't connect" screen — its data-fetch
    // couldn't handle them. Load the plain report page and drive the date
    // range entirely through the on-page UI instead.
    const reportUrl = "https://app.yoco.com/reports/products/home";
    console.log("Opening report:", reportUrl);
    await page.goto(reportUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(5_000);
    await shot(page, "04-report");

    // Yoco occasionally shows a transient "can't connect" screen — reload once.
    if (/can'?t connect/i.test(await page.textContent("body"))) {
      console.warn("Got a connectivity error screen — reloading once.");
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(5_000);
      await shot(page, "04b-report-retry");
    }

    await setDateRangeViaUi(page, start, end).catch((e) =>
      console.warn("Date-selector UI did not complete:", e.message)
    );
    await shot(page, "05-after-datepicker");

    /* ---- 3. download → Excel ---- */
    console.log("Downloading Excel export…");
    // Top-right "Export" button (real UI: visible text button, not an icon glyph).
    await page.getByText("Export", { exact: true }).first().click();
    await page.waitForTimeout(1_000);
    await shot(page, "06-download-menu");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      page.getByText("Excel", { exact: true }).first().click(),
    ]);
    const xlsxPath = join(DATA_DIR, "report.xlsx");
    await download.saveAs(xlsxPath);
    // Keep a dated copy so history accumulates.
    copyFileSync(xlsxPath, join(DATA_DIR, `report-${ymd(reportDay)}.xlsx`));
    console.log("Saved", xlsxPath);

    /* ---- 4. parse xlsx → latest.json ---- */
    const data = parseReport(xlsxPath, { start: ymd(start), end: ymd(end), reportDay: ymd(reportDay) });
    writeFileSync(join(DATA_DIR, "latest.json"), JSON.stringify(data, null, 2));
    console.log(`Wrote latest.json — ${data.topProducts.length} products.`);
  } finally {
    await shot(page, "99-final");
    await browser.close();
  }
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* Drive the on-page date selector. Yoco's app is React Native Web, so
   everything is a styled div — we go by visible text/role. The report page
   has a fixed row of period buttons (Today / Yesterday / This week /
   Last week / This month / Last month / Custom range / Location) — click
   "Custom range" (a real <button role="button">) to open the calendar. */
async function setDateRangeViaUi(page, start, end) {
  await page.getByRole("button", { name: "Custom range", exact: true }).click();
  await page.waitForTimeout(800);

  for (const d of [start, end]) {
    await navigateToMonth(page, d);
    await clickDay(page, d);
  }
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.waitForTimeout(3_000);
}

/* The ← / → month-navigation buttons are icon-only (MaterialIcons glyph,
   no text/aria-label) and otherwise identical — but they're the only
   circular 36x36 buttons in the calendar, and ← is first in DOM order.
   Our target dates are always in the past relative to "today" (the
   calendar's default), so we only ever need to click back. */
async function navigateToMonth(page, d) {
  const targetMonth = MONTH_NAMES[d.getUTCMonth()];
  const targetYear = String(d.getUTCFullYear());
  const backArrow = page
    .locator('button[style*="width: 36px"][style*="height: 36px"]')
    .first();
  const monthBtn = page
    .locator('button[role="button"]')
    .filter({ hasText: new RegExp(`^(${MONTH_NAMES.join("|")})$`) })
    .first();
  const yearBtn = page
    .locator('button[role="button"]')
    .filter({ hasText: /^\d{4}$/ })
    .first();

  for (let i = 0; i < 24; i++) {
    const curMonth = (await monthBtn.textContent())?.trim();
    const curYear = (await yearBtn.textContent())?.trim();
    if (curMonth === targetMonth && curYear === targetYear) return;
    await backArrow.click();
    await page.waitForTimeout(300);
  }
  console.warn(`navigateToMonth: gave up looking for ${targetMonth} ${targetYear}`);
}

/* Day cells belonging to the previous/next month (shown greyed-out to fill
   the grid) carry an extra "r-eu3ka" class that in-month days don't — click
   only cells without it so we never land on the wrong month's "30". */
async function clickDay(page, d) {
  const day = String(d.getUTCDate());
  const cell = page
    .locator("div.r-1awozwy:not(.r-eu3ka)")
    .filter({ hasText: new RegExp(`^${day}$`) })
    .first();
  if (await cell.count()) {
    await cell.click();
  } else {
    // fallback if the class name ever changes
    await page.getByText(day, { exact: true }).first().click();
  }
  await page.waitForTimeout(400);
}

/* Header-flexible xlsx → dashboard JSON. */
function parseReport(path, range) {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const pick = (row, ...names) => {
    for (const key of Object.keys(row)) {
      const k = key.toLowerCase();
      if (names.some((n) => k.includes(n))) return row[key];
    }
    return null;
  };
  const num = (v) =>
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[R,\s]/g, "")) || 0;

  const products = rows
    .map((r) => ({
      name: pick(r, "product", "item", "name", "description"),
      quantity: num(pick(r, "quantity", "qty", "count", "units", "sold")),
      revenue: num(pick(r, "gross", "revenue", "total", "amount", "net", "sales")),
    }))
    .filter((p) => p.name && !/^total/i.test(String(p.name)));

  return {
    scrapedAt: new Date().toISOString(),
    source: "yoco-products-report",
    report: range, // { start, end, reportDay }
    topProducts: products.sort((a, b) => b.revenue - a.revenue),
    totals: {
      revenue: products.reduce((s, p) => s + p.revenue, 0),
      quantity: products.reduce((s, p) => s + p.quantity, 0),
    },
    days: [], // this report has no per-day series; dashboard keeps its own trend
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseReport };
