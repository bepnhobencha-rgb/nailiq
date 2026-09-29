import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3105";

export default defineConfig({
  testDir: ".",
  testMatch: "email-only.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: "../../test-results/card-retry-email-ui",
  reporter: "list",
  use: { baseURL, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3105",
    cwd: "../..",
    url: `${baseURL}/e2e-local/card-retry-email`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:59999",
      SUPABASE_INTERNAL_URL: "http://127.0.0.1:59999",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-local-key",
      NEXT_PUBLIC_SITE_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      DISABLE_OUTBOUND_SMS: "1",
      DISABLE_OUTBOUND_EMAIL: "1",
      DISABLE_OUTBOUND_CALLS: "1",
    },
  },
});
