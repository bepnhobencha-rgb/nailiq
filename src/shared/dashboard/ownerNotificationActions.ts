"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  parseOwnerNotificationSettings,
  type OwnerNotificationSettings,
} from "@/shared/dashboard/ownerNotificationSettings";
import { sendOwnerNotificationTest } from "@/shared/dashboard/sendOwnerBookingNotification";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export async function getOwnerNotificationSettings(
  slug: string,
): Promise<
  | { ok: true; settings: OwnerNotificationSettings }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };
  const { data } = await ctx.supabase
    .from("salons")
    .select("owner_notification_settings" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const raw = (data as { owner_notification_settings?: unknown } | null)
    ?.owner_notification_settings;
  return { ok: true, settings: parseOwnerNotificationSettings(raw) };
}

export async function saveOwnerNotificationSettings(
  slug: string,
  input: unknown,
): Promise<
  | { ok: true; settings: OwnerNotificationSettings }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // parse normalizes/validates everything (emails, event flags, booleans).
  const clean = parseOwnerNotificationSettings(input);

  let admin: ReturnType<typeof createServiceRoleClient>;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "server_error" };
  }
  const { error } = await admin
    .from("salons")
    .update({ owner_notification_settings: clean } as never)
    .eq("id", ctx.salon.id);
  if (error) {
    console.error("[saveOwnerNotificationSettings]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, settings: clean };
}

export async function sendOwnerNotificationTestAction(
  slug: string,
): Promise<
  | { ok: true; recipientCount: number }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };
  return sendOwnerNotificationTest(ctx.salon.id);
}
