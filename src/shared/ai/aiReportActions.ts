"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { runDailyReport } from "./agentDailyReport";

const VALID_CHANNELS = ["email", "sms", "both"] as const;
type Channel = (typeof VALID_CHANNELS)[number];

function isValidChannel(v: unknown): v is Channel {
  return typeof v === "string" && (VALID_CHANNELS as readonly string[]).includes(v);
}

function isValidE164(v: unknown): boolean {
  if (!v || typeof v !== "string") return true; // empty is OK (clears the field)
  return /^\+[1-9]\d{6,14}$/.test(v.trim());
}

export async function getAIReportSettings(
  slug: string,
): Promise<
  | { ok: true; channel: Channel; ownerPhone: string }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const { data } = await createServiceRoleClient()
    .from("salons")
    .select("owner_notification_channel, owner_phone" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const row = data as {
    owner_notification_channel?: string | null;
    owner_phone?: string | null;
  } | null;

  return {
    ok: true,
    channel: isValidChannel(row?.owner_notification_channel)
      ? row!.owner_notification_channel
      : "email",
    ownerPhone: row?.owner_phone ?? "",
  };
}

export async function saveAIReportSettings(
  slug: string,
  input: { channel: unknown; ownerPhone: unknown },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    return { ok: false, error: "forbidden" };
  }

  const channel = isValidChannel(input.channel) ? input.channel : "email";
  const phone = typeof input.ownerPhone === "string" ? input.ownerPhone.trim() : "";

  if (phone && !isValidE164(phone)) {
    return { ok: false, error: "invalid_phone" };
  }

  const { error } = await createServiceRoleClient()
    .from("salons")
    .update({
      owner_notification_channel: channel,
      owner_phone: phone || null,
    } as never)
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[saveAIReportSettings]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true };
}

export async function sendTestDailyReport(
  slug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    return { ok: false, error: "forbidden" };
  }

  try {
    await runDailyReport(ctx.salon.id, { force: true });
    return { ok: true };
  } catch (e) {
    console.error("[sendTestDailyReport]", e);
    return { ok: false, error: "send_failed" };
  }
}
