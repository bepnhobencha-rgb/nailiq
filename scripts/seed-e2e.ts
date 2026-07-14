/**
 * Seed the throwaway E2E database.
 *
 * Deliberately thin. It composes the helpers the specs already use
 * (e2e/helpers/db.ts), rather than re-implementing inserts against a schema it
 * would only half-remember — a seed that drifts from the helpers produces
 * fixtures the specs cannot use, and the failure looks like a product bug.
 *
 * Every row it creates is marked:
 *   - salon slug   `e2e-baseline-<runId>`
 *   - user emails  `e2e-*@nailiq.test.invalid`   (reserved TLD, RFC 2606 —
 *                                                  no human can ever own one)
 *   - phones       555 exchange (unroutable; also hard-blocked from real sends)
 *   - passwords    random per run, in memory only, never logged
 *
 * `<runId>` is the GitHub Actions run id, so a fixture can always be traced back
 * to the run that made it. That mattered: the salon left in production was named
 * `e2e-rc-mobile-29298115054`, and the run id baked into the slug is how we
 * proved which workflow put it there.
 *
 * Idempotent: seedTestSalon() calls cleanupTestSalon() first, so a second run
 * replaces the fixture rather than duplicating it.
 *
 * Usage:  npx tsx scripts/seed-e2e.ts
 */
import { assertNotProductionFromEnv } from "../e2e/helpers/guardProduction";

// Refuses to run against production before a single row is written.
assertNotProductionFromEnv();

const runId = process.env.GITHUB_RUN_ID ?? "local";

async function main() {
  // Imported lazily: e2e/helpers/db.ts constructs a service-role client at module
  // load, and we want the guard above to have spoken first.
  const { seedTestSalon, seedTestUser } = await import("../e2e/helpers/db");

  const slug = `e2e-baseline-${runId}`;

  const salon = await seedTestSalon({
    slug,
    name: "E2E Baseline Salon",
    // 555 is the fictional exchange: unroutable by carriers, and the app blocks
    // it from real sends even on production. Two independent reasons a test can
    // never text a stranger.
    phone: "+15555550100",
    salon_phone: "+15555550101",
  });

  // One account per role the suite drives. Passwords are generated inside the
  // helper and returned in memory; nothing prints them.
  const owner = await seedTestUser();
  const staff = await seedTestUser();
  const customer = await seedTestUser();

  console.log("[seed-e2e] ready");
  console.log(`  salon    ${slug} (${salon.salonId})`);
  console.log(`  owner    ${owner.email}`);
  console.log(`  staff    ${staff.email}`);
  console.log(`  customer ${customer.email}`);
  console.log("  passwords: generated per run, not printed");
  // NOTE: no superadmin is seeded here. seedTestSuperadmin() mints a full
  // platform operator, and the specs that genuinely need one create and clean up
  // their own. A standing `founder` in the seed is how the last one escaped.
}

main().catch((err) => {
  console.error("[seed-e2e] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
