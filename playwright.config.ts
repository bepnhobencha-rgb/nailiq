import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import { defineConfig, devices } from "@playwright/test";

function loadDotEnv(filename: string) {
  const p = resolve(process.cwd(), filename);
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(".env.local");
loadDotEnv(".env.test.local");

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  // e2e/receptionist-center/helpers.ts:514-524 waits up to 45s for
  // `receptionist-center-loaded` / `staff-timeline-grid` / `walkin-add-form`
  // to handle slow Next dev-mode hydration. The default 30s test timeout
  // killed every dashboard-navigating test before that helper could
  // finish — visible in CI run 25686403140 as uniform 30.3s timeouts.
  // 90s gives headroom on cold compiles without masking real hangs.
  timeout: 90_000,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ...(isCI
      ? ([["json", { outputFile: "playwright-report/results.json" }]] as const)
      : []),
  ],
  use: {
    /** Match default `salons.timezone` (see seed + migrations); RPC v2.4 validates hours in salon TZ. */
    timezoneId: "America/Los_Angeles",
    baseURL:
      process.env.PLAYWRIGHT_BASE_URL ??
      process.env.BASE_URL ??
      "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
