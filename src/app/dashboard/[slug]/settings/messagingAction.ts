"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { revalidatePath } from "next/cache";

export async function updateMessagingSettings(
  slug: string,
  smsOutboundEnabled: boolean,
  emailOutboundEnabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "unauthorized" };
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update({
      sms_outbound_enabled: smsOutboundEnabled,
      email_outbound_enabled: emailOutboundEnabled,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };

  // Revalidate the settings page so the server component re-fetches fresh values.
  revalidatePath(`/dashboard/${slug}/settings`);

  return { ok: true };
}
