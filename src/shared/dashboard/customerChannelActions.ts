"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { CustomerChannelMode } from "@/shared/lib/channelResolver";
import { z } from "zod";
import { loadSalonOwnerAdminSettingsForDashboardContext } from "@/shared/dashboard/salonOwnerAdminSettings";

const CustomerChannelSettingsInput = z.object({
  smsOutboundEnabled: z.boolean(),
  emailOutboundEnabled: z.boolean(),
  customerChannel: z.enum(["smart", "sms_only", "email_only", "sms_and_email"]),
});

export interface CustomerChannelSettings {
  smsOutboundEnabled: boolean;
  emailOutboundEnabled: boolean;
  customerChannel: CustomerChannelMode;
}

export async function getCustomerChannelSettings(
  slug: string,
): Promise<{ ok: true; settings: CustomerChannelSettings } | { ok: false }> {
  try {
    const ctx = await getDashboardWriteClient(slug);
    if (!ctx) return { ok: false };
    if (!isOwnerOrAdmin(ctx.role)) return { ok: false };
    const loaded = await loadSalonOwnerAdminSettingsForDashboardContext(ctx);
    if (!loaded.ok) return { ok: false };
    const d = loaded.settings as { sms_outbound_enabled?: boolean | null; email_outbound_enabled?: boolean | null; customer_channel?: string };
    return {
      ok: true,
      settings: {
        smsOutboundEnabled: d.sms_outbound_enabled !== false,
        emailOutboundEnabled: d.email_outbound_enabled !== false,
        customerChannel: (d.customer_channel || "smart") as CustomerChannelMode,
      },
    };
  } catch {
    return { ok: false };
  }
}

export async function saveCustomerChannelSettings(
  slug: string,
  settings: CustomerChannelSettings,
): Promise<{ ok: true; settings: CustomerChannelSettings } | { ok: false; error: string }> {
  try {
    const ctx = await getDashboardWriteClient(slug);
    if (!ctx) return { ok: false, error: "unauthorized" };
    if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

    const parsed = CustomerChannelSettingsInput.safeParse(settings);
    if (!parsed.success) return { ok: false, error: "invalid_input" };
    const clean = parsed.data;

    const { error } = await ctx.supabase
      .from("salons")
      .update({
        sms_outbound_enabled: clean.smsOutboundEnabled,
        email_outbound_enabled: clean.emailOutboundEnabled,
        customer_channel: clean.customerChannel,
      } as never)
      .eq("id", ctx.salon.id);

    if (error) return { ok: false, error: error.message };
    return { ok: true, settings: clean };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
