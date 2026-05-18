import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import { defineConfig, devices } from "@playwright/test";

function loadDotEnv(filename: string, override = false) {
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
    if (override || process.env[key] === undefined) process.env[key] = val;
  }
}

// .env.test.local is loaded with override=true so its E2E-specific values
// (NEXT_PUBLIC_DEMO_OTP=true, NAILIQ_TEST_BYPASS_SLUG_PIN=1) always win over
// whatever is set in .env.local for the test runner process.
// NOTE: the Next.js dev server reads .env.local directly; start it with
// NEXT_PUBLIC_DEMO_OTP=true NAILIQ_TEST_BYPASS_SLUG_PIN=1 npm run dev
// (or use `npm run dev:test`) when running E2E locally.
loadDotEnv(".env.local");
loadDotEnv(".env.test.local", true);

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
    // Pass E2E-required flags so a freshly-started server has demo mode on.
    // reuseExistingServer: if a server is already running on :3000 it will
    // be reused as-is — restart it via `npm run dev:test` if demo flags are
    // needed (see .env.test.local.example).
    command:
      "NEXT_PUBLIC_DEMO_OTP=true DEMO_OTP=true NAILIQ_TEST_BYPASS_SLUG_PIN=1 npm run dev",
    url: "http://localhost:3000",
    // In CI we pre-start `next dev` in the workflow and gate the job on
    // a 30s wait-on health check (see .github/workflows/e2e.yml). The
    // pre-flight is the real fail-fast signal; here we just reuse that
    // running server. Locally we keep the standard reuse-when-existing
    // behaviour so re-running specs against an open `npm run dev` works.
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
