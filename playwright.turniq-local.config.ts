import { defineConfig, devices } from "@playwright/test";

/**
 * Provider-free runner for loopback-only TurnIQ stories. It deliberately has
 * no global seed/sweep and no service-role credential because these pages use
 * synthetic in-memory state and intercepted endpoints only.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["turniq-*-local.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3017",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"], browserName: "webkit" } },
  ],
  webServer: {
    command: "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=turniq-local-anon NEXT_PUBLIC_DEMO_OTP=true DEMO_OTP=true NAILIQ_TEST_BYPASS_SLUG_PIN=1 DISABLE_OUTBOUND_SMS=1 DISABLE_OUTBOUND_CALLS=1 npm run dev -- --hostname 127.0.0.1 --port 3017",
    url: "http://127.0.0.1:3017",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
