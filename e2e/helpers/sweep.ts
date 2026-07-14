import { createClient } from "@supabase/supabase-js";

import {
  assertNotProductionFromEnv,
  isE2EEmail,
  isE2ESlug,
  E2E_SLUG_PREFIX,
} from "./guardProduction";

/**
 * Marker-scoped removal of E2E-owned rows. Shared by the Playwright
 * globalTeardown and by `scripts/e2e-sweep.ts` (which CI runs with
 * `if: always()` so a cancelled job still cleans up).
 *
 * Only ever deletes rows whose marker proves a test created them:
 *   - auth users: email `e2e-*@nailiq.test.invalid`
 *   - salons:     slug  `e2e-*`
 *
 * No date windows, no `%test%` matching, no "created in the last hour" —
 * conditions like that are how a cleanup job eventually eats real data.
 * Idempotent: a second run on a clean database is a no-op.
 */
export async function sweep(): Promise<{ users: number; salons: number }> {
  assertNotProductionFromEnv();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl?.trim() || !serviceKey?.trim()) {
    return { users: 0, salons: 0 };
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  let users = 0;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const batch = data?.users ?? [];
    if (batch.length === 0) break;

    for (const user of batch) {
      if (!isE2EEmail(user.email)) continue; // the only deletion condition
      // Drop the privilege grant first: a partial failure must never leave an
      // account behind that still holds superadmin.
      await supabase.from("superadmins").delete().eq("user_id", user.id);
      const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
      if (delErr) {
        console.warn(`[e2e-sweep] keep ${user.id}: ${delErr.message}`);
        continue;
      }
      users += 1;
    }
    if (batch.length < 200) break;
  }

  const { data: salonRows, error: salonErr } = await supabase
    .from("salons")
    .select("id, slug")
    .like("slug", `${E2E_SLUG_PREFIX}%`);
  if (salonErr) throw new Error(`salon lookup failed: ${salonErr.message}`);

  let salons = 0;
  for (const salon of salonRows ?? []) {
    if (!isE2ESlug(salon.slug)) continue; // re-check in code, not just in SQL
    const { error: delErr } = await supabase
      .from("salons")
      .delete()
      .eq("id", salon.id);
    if (delErr) {
      console.warn(`[e2e-sweep] keep salon ${salon.slug}: ${delErr.message}`);
      continue;
    }
    salons += 1;
  }

  return { users, salons };
}
