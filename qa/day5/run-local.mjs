import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

// Local-only runner: never read dotenv files or inherit provider credentials.
const root = process.cwd();
const stack = "/private/tmp/nailiq-day5-stack";
const dockerHost = "unix:///Users/huytran/.colima/nailiq-p0-503/docker.sock";
const mode = process.argv[2];
if (!["baseline", "build", "test", "serve", "parity", "manual", "manual-owner"].includes(mode)) throw new Error("Unknown QA mode");
for (const file of [".env", ".env.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"]) {
  if (existsSync(resolve(root, file))) throw new Error(`REFUSE dotenv: ${file}`);
}
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DOCKER_HOST: dockerHost };
const raw = execFileSync("npx", ["--offline", "supabase@2.117.0", "status", "-o", "json"], {
  cwd: stack, env: baseEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const status = JSON.parse(raw);
if (status.API_URL !== "http://127.0.0.1:54321" || new URL(status.DB_URL).hostname !== "127.0.0.1" || new URL(status.DB_URL).port !== "54322") {
  throw new Error("REFUSE non-local stack");
}
if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error("Local keys missing");
const runEnv = {
  ...baseEnv,
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  SUPABASE_INTERNAL_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  E2E_EXPECTED_LOCAL_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  DB_URL: status.DB_URL,
  PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3117",
  NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3117",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3117",
  NAILIQ_DISPOSABLE_DB: "1",
  NEXT_PUBLIC_DEMO_OTP: "false", DEMO_OTP: "false", NAILIQ_TEST_BYPASS_SLUG_PIN: "0",
  DISABLE_OUTBOUND_SMS: "1", DISABLE_OUTBOUND_EMAIL: "1", DISABLE_OUTBOUND_CALLS: "1",
  NAILIQ_CARD_SAVE_DISPATCH_DISABLED: "true",
  PAYMENT_LEDGER_WORKERS_ENABLED: "false",
  NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH: "false",
  NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH: "false",
  NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION: "false",
  INTERNAL_API_SECRET: randomBytes(32).toString("hex"),
};
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env: runEnv, stdio: capture ? "pipe" : "inherit", encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (capture) {
    // SQL scripts contain only checked-in schema, not customer data or credentials.
    console.log((result.stdout ?? "").split("\n").slice(-18).join("\n"));
    if (result.status !== 0) console.error((result.stderr ?? "").split("\n").slice(-18).join("\n"));
  }
  if (result.status !== 0) throw new Error(`QA step failed: ${command} (${result.status})`);
}
run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/assert-e2e-not-production.ts"]);
if (mode === "baseline") {
  const count = execFileSync("psql", [status.DB_URL, "-tAc", "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"], {env: runEnv, encoding: "utf8"}).trim();
  if (count !== "0") throw new Error("REFUSE baseline on non-empty public schema");
  run("bash", ["scripts/apply-baseline.sh", status.DB_URL], true);
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-schema-parity.ts"], true);
} else if (mode === "parity") {
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-schema-parity.ts"], true);
} else if (mode === "build") {
  run(process.execPath, ["node_modules/next/dist/bin/next", "build"], true);
} else if (mode === "test") {
  run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "qa/day5/playwright.config.ts", ...process.argv.slice(3)]);
} else if (mode === "manual" || mode === "manual-owner") {
  run(process.execPath, ["node_modules/tsx/dist/cli.mjs", "qa/day5/manual-fixture.ts", ...(mode === "manual-owner" ? ["owner", ...(process.argv[3] === "loyalty" ? ["loyalty"] : [])] : [])]);
} else {
  run(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "3117"]);
}
