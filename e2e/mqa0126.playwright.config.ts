import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import baseConfig from "../playwright.config";

const LOCAL_APP_URL = "http://127.0.0.1:3100";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOG_FILE = String(
  process.env.MQA0126_FAKE_SQUARE_LOG_FILE || "",
).trim();
const RUN_NONCE = String(process.env.MQA0126_RUN_NONCE || "").trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (
  process.env.MQA0126_FAKE_SQUARE_REFUND !== "1" ||
  process.env.NAILIQ_DISPOSABLE_DB !== "1" ||
  process.env.NEXT_PUBLIC_SUPABASE_URL !== LOCAL_SUPABASE_URL ||
  process.env.SUPABASE_INTERNAL_URL !== LOCAL_SUPABASE_URL ||
  process.env.MQA0126_APP_URL !== LOCAL_APP_URL ||
  !LOG_FILE ||
  !UUID_RE.test(RUN_NONCE) ||
  process.env.VERCEL_ENV === "production"
) {
  throw new Error(
    "MQA0126 Playwright config requires explicit disposable loopback-only gates",
  );
}

const logParent = realpathSync.native(dirname(LOG_FILE));
const allowedLogParents = ["/private/tmp", tmpdir()]
  .filter((parent, index, candidates) =>
    existsSync(parent) && candidates.indexOf(parent) === index,
  )
  .map((parent) => realpathSync.native(parent));
if (
  !isAbsolute(LOG_FILE) ||
  !allowedLogParents.some(
    (parent) => logParent === parent || logParent.startsWith(`${parent}${sep}`),
  )
) {
  throw new Error("MQA0126 fake Square log must be an absolute temporary path");
}

if (existsSync(LOG_FILE)) {
  const logStat = lstatSync(LOG_FILE);
  if (logStat.isSymbolicLink() || !logStat.isFile()) {
    throw new Error("MQA0126 fake Square log must be a regular file");
  }
}

// The general E2E dotenv intentionally defaults PLAYWRIGHT_BASE_URL to :3000.
// This opt-in harness pins its isolated app after those files are loaded.
process.env.PLAYWRIGHT_BASE_URL = LOCAL_APP_URL;

const preload = resolve(
  process.cwd(),
  "e2e/helpers/mqa0126FakeSquareRefundTransport.cjs",
);

export default defineConfig({
  ...baseConfig,
  testDir: resolve(process.cwd(), "e2e"),
  globalSetup: resolve(process.cwd(), "e2e/helpers/globalSetup.ts"),
  globalTeardown: resolve(process.cwd(), "e2e/helpers/globalTeardown.ts"),
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...baseConfig.use,
    baseURL: LOCAL_APP_URL,
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: LOCAL_APP_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
      SUPABASE_INTERNAL_URL: LOCAL_SUPABASE_URL,
      NEXT_PUBLIC_DEMO_OTP: "true",
      DEMO_OTP: "true",
      NAILIQ_TEST_BYPASS_SLUG_PIN: "1",
      DISABLE_OUTBOUND_SMS: "1",
      DISABLE_OUTBOUND_EMAIL: "1",
      DISABLE_OUTBOUND_CALLS: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
