"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  parseStaffNotificationSettings,
  type StaffNotificationSettings,
} from "@/shared/dashboard/staffNotificationSettings";

function canManage(role: string): boolean {
  return role === "owner" || role === "admin";
}

export async function getStaffNotificationSettings(
  slug: string,
): Promise<
  | { ok: true; settings: StaffNotificationSettings }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  const { data } = await ctx.supabase
    .from("salons")
    .select("staff_notification_settings" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  const raw = (data as { staff_notification_settings?: unknown } | null)
    ?.staff_notification_settings;
  return { ok: true, settings: parseStaffNotificationSettings(raw) };
}

export async function saveStaffNotificationSettings(
  slug: string,
  input: unknown,
): Promise<
  | { ok: true; settings: StaffNotificationSettings }
  | { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!canManage(ctx.role)) return { ok: false, error: "forbidden" };

  // parse normalizes/validates channels, event flags, locale, booleans.
  const clean = parseStaffNotificationSettings(input);

  let admin: ReturnType<typeof createServiceRoleClient>;
  try {
    admin = createServiceRoleClient();
  } catch {
    return { ok: false, error: "server_error" };
  }
  // Write the JSONB AND keep `default_notification_locale` (the column the
  // delivery path actually reads) in sync with the chosen default language.
  const { error } = await admin
    .from("salons")
    .update({
      staff_notification_settings: clean,
      default_notification_locale: clean.defaultLocale,
    } as never)
    .eq("id", ctx.salon.id);
  if (error) {
    console.error("[saveStaffNotificationSettings]", error);
    return { ok: false, error: "server_error" };
  }
  return { ok: true, settings: clean };
}
