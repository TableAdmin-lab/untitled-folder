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
// Debug: writes screenshots + DOM summaries to ../debug/ so failures are diagnosable.

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
const TEXT_LIMIT = 12_000;

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

const clip = (s = "", n = TEXT_LIMIT) => {
  const clean = String(s).replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
};

const fileSafe = (s) => String(s).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "");
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function debugPage(page, name, extra = {}) {
  const safeName = fileSafe(name);
  await shot(page, safeName);

  const snapshot = await page.evaluate(() => {
    const clipInPage = (s = "", n = 1600) => {
      const clean = String(s).replace(/\s+/g, " ").trim();
      return clean.length > n ? `${clean.slice(0, n)}…` : clean;
    };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        text: clipInPage(el.innerText || el.textContent || "", 260),
        ariaLabel: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        placeholder: el.getAttribute("placeholder"),
        type: el.getAttribute("type"),
        disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
        classes: clipInPage(el.className || "", 220),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    };

    const all = Array.from(document.querySelectorAll("body *")).filter(visible);
    const interactive = all
      .filter((el) =>
        ["button", "a", "input", "select", "textarea"].includes(el.tagName.toLowerCase()) ||
        ["button", "link", "menuitem", "option", "tab", "textbox"].includes(el.getAttribute("role") || "") ||
        el.hasAttribute("aria-label")
      )
      .slice(0, 160)
      .map(describe);

    const sections = Array.from(
      document.querySelectorAll(
        'main, section, form, nav, aside, header, footer, [role="main"], [role="dialog"], [role="menu"], [role="listbox"], [role="tabpanel"]'
      )
    )
      .filter(visible)
      .slice(0, 45)
      .map((el) => ({
        ...describe(el),
        text: clipInPage(el.innerText || el.textContent || "", 1200),
      }));

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']"))
      .filter(visible)
      .slice(0, 80)
      .map(describe);

    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      bodyText: clipInPage(document.body?.innerText || "", 4000),
      headings,
      sections,
      interactive,
    };
  }).catch((err) => ({ error: String(err?.message || err) }));

  const data = {
    capturedAt: new Date().toISOString(),
    name: safeName,
    extra,
    ...snapshot,
  };
  writeFileSync(join(DEBUG_DIR, `${safeName}.json`), JSON.stringify(data, null, 2));
  writeFileSync(
    join(DEBUG_DIR, `${safeName}.txt`),
    [
      `# ${safeName}`,
      `capturedAt: ${data.capturedAt}`,
      `url: ${data.url || ""}`,
      `title: ${data.title || ""}`,
      `extra: ${JSON.stringify(extra)}`,
      "",
      "## Body",
      clip(data.bodyText || ""),
      "",
      "## Headings",
      ...(data.headings || []).map((el, i) => `${i + 1}. ${el.tag}${el.role ? ` role=${el.role}` : ""}: ${el.text || el.ariaLabel || ""}`),
      "",
      "## Sections",
      ...(data.sections || []).map((el, i) => `${i + 1}. ${el.tag}${el.role ? ` role=${el.role}` : ""} ${JSON.stringify(el.rect)}\n${el.text || ""}`),
      "",
      "## Interactive Elements",
      ...(data.interactive || []).map((el, i) => {
        const label = el.text || el.ariaLabel || el.placeholder || el.title || "";
        return `${i + 1}. ${el.tag}${el.role ? ` role=${el.role}` : ""}${el.type ? ` type=${el.type}` : ""}${el.disabled ? " disabled" : ""} ${JSON.stringify(el.rect)} :: ${label}`;
      }),
      "",
    ].join("\n")
  );
}

async function clickVisibleControl(page, label, { roles = ["button"], timeout = 30_000 } = {}) {
  const pattern = label instanceof RegExp ? label : new RegExp(`\\b${escapeRe(label)}\\b`, "i");
  const candidates = [
    ...roles.map((role) => page.getByRole(role).filter({ hasText: pattern })),
    page.locator("button").filter({ hasText: pattern }),
  ];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const locator of candidates) {
      const count = Math.min(await locator.count().catch(() => 0), 8);
      for (let i = 0; i < count; i++) {
        const candidate = locator.nth(i);
        if ((await candidate.isVisible().catch(() => false)) && (await candidate.isEnabled().catch(() => false))) {
          await candidate.click({ timeout: 5_000 });
          return;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  await debugPage(page, `click-${fileSafe(String(label))}-failed`, {
    phase: "visible-control-not-found",
    label: String(label),
    roles,
  });
  throw new Error(`Could not find a visible enabled ${roles.join("/")} labelled "${label}"`);
}

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
    await debugPage(page, "04-report", { phase: "report-loaded" });

    // Yoco occasionally shows a transient "can't connect" screen — reload once.
    if (/can'?t connect/i.test(await page.textContent("body"))) {
      console.warn("Got a connectivity error screen — reloading once.");
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(5_000);
      await debugPage(page, "04b-report-retry", { phase: "report-reloaded" });
    }

    await setDateRangeViaUi(page, start, end).catch(async (e) => {
      console.warn("Date-selector UI did not complete:", e.message);
      await debugPage(page, "05z-datepicker-error", {
        phase: "date-selector-error",
        error: e.message,
        start: ymd(start),
        end: ymd(end),
      });
      await page.keyboard.press("Escape").catch(() => {}); // close any stuck calendar overlay
      throw e;
    });
    await debugPage(page, "05-after-datepicker", {
      phase: "date-selector-finished",
      start: ymd(start),
      end: ymd(end),
    });

    // Applying the custom range triggers a report data reload (visible as
    // spinners on the page) during which "Export" is briefly not rendered.
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2_000);

    /* ---- 3. download → Excel ---- */
    console.log("Downloading Excel export…");
    // Top-right "Export" button. Avoid getByText().first(): Yoco also renders
    // hidden offscreen text nodes named "Export", which are not clickable.
    await clickVisibleControl(page, "Export");
    await page.waitForTimeout(1_000);
    await debugPage(page, "06-download-menu", { phase: "export-menu-open" });

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }),
      clickVisibleControl(page, "Excel", { roles: ["button", "menuitem", "option"] }),
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
  await debugPage(page, "05a-before-custom-range", {
    phase: "before-custom-range-click",
    start: ymd(start),
    end: ymd(end),
  });
  await page.getByRole("button", { name: "Custom range", exact: true }).click();
  await page.waitForTimeout(800);
  await debugPage(page, "05b-custom-range-open", {
    phase: "custom-range-open",
    start: ymd(start),
    end: ymd(end),
  });

  for (const [index, d] of [start, end].entries()) {
    await navigateToMonth(page, d);
    await debugPage(page, `05c-${index ? "end" : "start"}-month-${ymd(d)}`, {
      phase: "target-month-visible",
      date: ymd(d),
    });
    await clickDay(page, d);
    await debugPage(page, `05d-${index ? "end" : "start"}-day-${ymd(d)}-selected`, {
      phase: "target-day-clicked",
      date: ymd(d),
    });
  }
  await debugPage(page, "05e-before-apply", {
    phase: "before-apply",
    start: ymd(start),
    end: ymd(end),
  });
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
  // These buttons render as e.g. "July" followed by a hidden MaterialIcons
  // glyph character (invisible on screen but present in textContent), so
  // exact/anchored text matching never hits — match the substring instead.
  const monthBtn = page
    .locator('button[role="button"]')
    .filter({ hasText: new RegExp(MONTH_NAMES.join("|")) })
    .first();
  const yearBtn = page
    .locator('button[role="button"]')
    .filter({ hasText: /\d{4}/ })
    .first();

  for (let i = 0; i < 24; i++) {
    const monthText = (await monthBtn.textContent()) || "";
    const yearText = (await yearBtn.textContent()) || "";
    const curMonth = MONTH_NAMES.find((m) => monthText.includes(m));
    const curYear = yearText.match(/\d{4}/)?.[0];
    if (curMonth === targetMonth && curYear === targetYear) return;
    await backArrow.click();
    await page.waitForTimeout(300);
  }
  await debugPage(page, `05x-missing-month-${targetMonth}-${targetYear}`, {
    phase: "missing-target-month",
    targetMonth,
    targetYear,
  });
  throw new Error(`navigateToMonth: gave up looking for ${targetMonth} ${targetYear}`);
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
    await page.waitForTimeout(400);
    return;
  }

  await debugPage(page, `05x-missing-day-${ymd(d)}`, {
    phase: "missing-target-day",
    date: ymd(d),
  });

  try {
    // fallback if the class name ever changes
    await page.getByText(day, { exact: true }).first().click();
  } catch (e) {
    throw new Error(`clickDay: could not click ${ymd(d)} (${e.message})`);
  }
  await page.waitForTimeout(400);
}

/* Header-flexible xlsx → dashboard JSON. */
function parseReport(path, range) {
  const wb = XLSX.read(readFileSync(path), { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const pick = (row, ...names) => {
    for (const name of names) {
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().includes(name)) return row[key];
      }
    }
    return null;
  };
  const num = (v) =>
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[R,\s]/g, "")) || 0;

  const products = rows
    .map((r) => ({
      name: pick(r, "product", "item", "name", "description"),
      quantity: num(pick(r, "quantity", "qty", "count", "units", "sold")),
      revenue: num(pick(r, "total", "revenue", "amount", "gross sales", "net", "sales", "gross")),
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
