import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const registry = read("src/shared/features/featureRegistry.ts");
const offlineMigration = read("supabase/migrations/20260902202020_add_turniq_primary_offline_device.sql");
const pilotMigration = read("supabase/migrations/20260902205914_add_turniq_pilot_hardening.sql");

const checks = [
  ["TurnIQ defaults OFF", /turniq_trust_engine:[\s\S]*?defaultOn:\s*false/.test(registry)],
  ["offline migration enables no salon", !/UPDATE\s+public\.salons|INSERT\s+INTO\s+public\.salons/i.test(offlineMigration)],
  ["pilot evidence is read-only", !/\b(INSERT|UPDATE|DELETE)\b/i.test(pilotMigration)],
  ["offline history is preserved", offlineMigration.includes("Never drop command/event/receipt history")],
  ["pilot ledger is preserved", pilotMigration.includes("keep immutable TurnIQ ledgers")],
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}\n`);
if (failed.length > 0) process.exitCode = 1;
