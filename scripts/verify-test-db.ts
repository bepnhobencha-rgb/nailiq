/**
 * Verify a Supabase project is fit to be the E2E test database.
 *
 * Run this once after creating the test project, and again whenever the schema
 * moves. It answers three questions, in the order that matters:
 *
 *   1. Is this actually NOT production?  (guardProduction — refuses otherwise)
 *   2. Does it have the schema E2E needs? (a missing table fails the suite in a
 *      way that looks like a product bug, which is how you lose an afternoon)
 *   3. Is it free of real customer data?  (nobody should ever copy the customer
 *      table into a test database, and a check beats a promise)
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/verify-test-db.ts
 */
import { createClient } from "@supabase/supabase-js";

import { assertNotProductionFromEnv } from "../e2e/helpers/guardProduction";

// Refuses to run against production before a single query goes out.
assertNotProductionFromEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url?.trim() || !key?.trim()) {
  console.error(
    "verify-test-db needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (of the TEST project).",
  );
  process.exit(1);
}

const db = createClient(url, key);

/** Tables the E2E suite reads or writes. A gap here breaks the suite. */
const REQUIRED_TABLES = [
  "salons",
  "staff",
  "services",
  "bookings",
  "booking_events",
  "booking_notifications",
  "salon_members",
  "salon_clients",
  "client_profiles",
  "superadmins",
  "superadmin_audit_logs",
  "queue_entries",
  "party_links",
  "booking_waitlist_entries",
  "platform_flags",
  "otps",
] as const;

/**
 * Tables that must be EMPTY of production rows. The E2E database exists so that
 * tests stop writing into customer data; copying customer data into it would
 * defeat the point and turn a test failure into a privacy incident.
 */
const MUST_BE_CLEAN = ["client_profiles", "bookings", "salons"] as const;

async function main() {
  let failed = false;

  console.log(`\n▶ Target: ${url}\n`);

  console.log("── Schema ──");
  for (const table of REQUIRED_TABLES) {
    const { error } = await db.from(table).select("*", { count: "exact", head: true });
    if (error) {
      failed = true;
      console.log(`  ✗ ${table.padEnd(26)} MISSING (${error.message})`);
    } else {
      console.log(`  ✓ ${table.padEnd(26)} present`);
    }
  }

  console.log("\n── No customer data ──");
  for (const table of MUST_BE_CLEAN) {
    const { count, error } = await db
      .from(table)
      .select("*", { count: "exact", head: true });
    if (error) {
      failed = true;
      console.log(`  ✗ ${table.padEnd(26)} could not read (${error.message})`);
      continue;
    }
    const rows = count ?? 0;
    // Fixtures the suite seeds are fine; a pile of rows is not — that is a copy
    // of production, and it should never have been made.
    if (rows > 50) {
      failed = true;
      console.log(
        `  ✗ ${table.padEnd(26)} ${rows} rows — this looks like COPIED PRODUCTION DATA. ` +
          `The test database must never hold real customers.`,
      );
    } else {
      console.log(`  ✓ ${table.padEnd(26)} ${rows} row(s) — fixtures only`);
    }
  }

  console.log(
    failed
      ? "\n✗ Not ready. Fix the above before pointing CI at this project.\n"
      : "\n✓ Ready. Set the repo secrets/variable and E2E will run against this project.\n",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-test-db failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
