"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import {
  SMS_TEMPLATE_DEFINITIONS,
  parseSmsTemplateSettings,
  type SmsTemplateSettings,
} from "@/shared/lib/smsTemplateRegistry";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type SmsTemplateSettingsResult =
  | { ok: true; settings: SmsTemplateSettings }
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_input" | "unavailable" };

function completeSettings(value: unknown): SmsTemplateSettings {
  const parsed = parseSmsTemplateSettings(value);
  return Object.fromEntries(
    SMS_TEMPLATE_DEFINITIONS
      .filter((definition) => !definition.required)
      .map((definition) => [
        definition.key,
        parsed[definition.key] !== false,
      ]),
  ) as SmsTemplateSettings;
}

function validateSettings(value: unknown): SmsTemplateSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const optionalKeys = new Set(
    SMS_TEMPLATE_DEFINITIONS
      .filter((definition) => !definition.required)
      .map((definition) => definition.key),
  );
  if (Object.keys(input).some((key) => !optionalKeys.has(key as never))) return null;
  if (Object.values(input).some((enabled) => typeof enabled !== "boolean")) return null;
  return completeSettings(input);
}

export async function getSmsTemplateSettings(
  slug: string,
): Promise<SmsTemplateSettingsResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { data, error } = await createServiceRoleClient()
    .from("salon_sms_template_settings" as never)
    .select("settings")
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (error) return { ok: false, error: "unavailable" };
  return {
    ok: true,
    settings: completeSettings(
      (data as { settings?: unknown } | null)?.settings,
    ),
  };
}

export async function saveSmsTemplateSettings(
  slug: string,
  value: unknown,
): Promise<SmsTemplateSettingsResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };
  const settings = validateSettings(value);
  if (!settings) return { ok: false, error: "invalid_input" };

  const { data: authData } = await ctx.supabase.auth.getUser();
  const { error } = await createServiceRoleClient()
    .from("salon_sms_template_settings" as never)
    .upsert({
      salon_id: ctx.salon.id,
      settings,
      updated_by: authData.user?.id ?? null,
      updated_at: new Date().toISOString(),
    } as never, { onConflict: "salon_id" } as never);
  if (error) return { ok: false, error: "unavailable" };
  return { ok: true, settings };
}
