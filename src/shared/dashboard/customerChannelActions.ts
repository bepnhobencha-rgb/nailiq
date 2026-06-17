"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import type { CustomerChannelMode } from "@/shared/lib/channelResolver";

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
    const { data } = await ctx.supabase
      .from("salons")
      .select("sms_outbound_enabled, email_outbound_enabled, customer_channel" as never)
      .eq("id", ctx.salon.id)
      .maybeSingle();
    if (!data) return { ok: false };
    const d = data as { sms_outbound_enabled?: boolean | null; email_outbound_enabled?: boolean | null; customer_channel?: string };
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

    const { error } = await ctx.supabase
      .from("salons")
      .update({
        sms_outbound_enabled: settings.smsOutboundEnabled,
        email_outbound_enabled: settings.emailOutboundEnabled,
        customer_channel: settings.customerChannel,
      } as never)
      .eq("id", ctx.salon.id);

    if (error) return { ok: false, error: error.message };
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
