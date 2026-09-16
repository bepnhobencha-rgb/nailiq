import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  resolveTenantEntitlements,
  type TenantEntitlements,
} from "@/shared/subscriptions/tenantEntitlements";

/**
 * Load the small control-plane projection only after the caller has proved the
 * exact tenant. A missing/error result fails closed for mutation capabilities
 * while retaining no cross-tenant data in the returned object.
 */
export async function loadTenantEntitlements(
  salonId: string,
  now: Date = new Date(),
): Promise<TenantEntitlements> {
  try {
    const { data, error } = await createServiceRoleClient()
      .from("salons")
      .select(
        "archived_at, superadmin_locked_at, subscription_status, trial_ends_at, feature_flags" as never,
      )
      .eq("id", salonId)
      .maybeSingle();
    if (error || !data) return resolveTenantEntitlements({}, now);
    return resolveTenantEntitlements(
      data as unknown as Parameters<typeof resolveTenantEntitlements>[0],
      now,
    );
  } catch {
    return resolveTenantEntitlements({}, now);
  }
}
