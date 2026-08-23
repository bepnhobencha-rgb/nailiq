import "server-only";

import { isReleaseFeatureVisible } from "@/shared/features/platformFeatureFlags";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type FeatureSalon = Parameters<typeof isReleaseFeatureVisible>[0] & {
  id: string;
};

/** One server-owned rollout gate shared by the page, detail loader and write. */
export async function isArchivedBookingFeatureAvailable(
  salon: FeatureSalon,
): Promise<boolean> {
  if (!(await isReleaseFeatureVisible(salon, "archived_booking_recovery"))) {
    return false;
  }
  try {
    const { data, error } = await createServiceRoleClient()
      .from("wix_integrations")
      .select("salon_id")
      .eq("salon_id", salon.id)
      .eq("enabled", true)
      .maybeSingle();
    return !error && !data?.salon_id;
  } catch {
    return false;
  }
}
