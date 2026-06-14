/**
 * One-time helper: capture a logged-in prod session for the qa-tester agent.
 *
 * Opens a REAL browser to the Hi-Lite dashboard on prod. You log in (phone +
 * OTP) yourself, then press Enter in the terminal — the script saves the
 * Playwright storageState (cookies + localStorage) to
 * `.claude/qa/hilite-storage.json` (gitignored). The qa-tester agent reuses it
 * to QA the prod dashboard without a fresh login, until the session expires
 * (re-run this when QA starts hitting the login wall).
 *
 * Run:  node scripts/qa-capture-session.mjs
 * (In a Claude Code session you can run it with the `!` prefix.)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const SLUG = "hilite-anaheim";
const START_URL = `https://www.nailiq.ca/dashboard/${SLUG}/center`;
const OUT = ".claude/qa/hilite-storage.json";

function waitForEnter(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log("\n=== NailIQ QA — bắt session prod (Hi-Lite) ===");
console.log("1) Cửa sổ trình duyệt vừa mở → ĐĂNG NHẬP Hi-Lite (số điện thoại + OTP).");
console.log("2) Khi đã vào được dashboard Receptionist Center, quay lại đây.");
await waitForEnter("\n>>> Đăng nhập xong thì bấm ENTER để lưu session... ");

mkdirSync(dirname(OUT), { recursive: true });
await ctx.storageState({ path: OUT });
console.log(`\n✅ Đã lưu session → ${OUT}`);
console.log("   (file này đã gitignore — không bị commit). qa-tester sẽ tự dùng.");
await browser.close();
process.exit(0);
