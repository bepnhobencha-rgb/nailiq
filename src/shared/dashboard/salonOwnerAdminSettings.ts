import "server-only";

import type { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type RequestSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type SalonOwnerAdminSettings = Record<string, unknown>;

export type SalonOwnerAdminSettingsResult =
  | {
      ok: true;
      role: "owner" | "admin";
      settings: SalonOwnerAdminSettings;
    }
  | { ok: false; code: string };

const SALON_OWNER_ADMIN_SETTINGS_SELECT =
  "dashboard_modules, dashboard_preset, email, email_verified, subscription_plan, brand_color, logo_url, theme_mode, walkin_auto_assign, queue_display_mode, phone_otp_enabled, reminders_enabled, reminder_24h_enabled, reminder_3h_enabled, sms_reminders_enabled, booking_verification_mode, google_review_url, google_place_id, yelp_business_id, voice_ai_enabled, voice_ai_persona_name, vertical, staff_selection_enabled, booking_lead_minutes, group_together_threshold_minutes, group_decline_cutoff_hours, reference_image_enabled, auto_no_show_minutes, winback_enabled, client_segment_settings, feature_flags, resources_enabled, primary_grid_axis, ai_manager_instructions, sms_outbound_enabled, email_outbound_enabled, customer_channel, owner_notification_channel, owner_phone, owner_notification_settings, staff_notification_settings, default_notification_locale, timezone, tax_lines, cancellation_policy, payment_provider, noshow_protection_enabled, noshow_fee_percent, noshow_risk_threshold, noshow_group_whole_party, noshow_deposit_escalation_threshold, noshow_require_new_customer, noshow_require_prior_noshow, noshow_min_noshow_count, noshow_require_high_risk, self_cancel_window_hours, self_cancel_fee_enabled, self_cancel_fee_percent";

export type SalonMemberOperationalProfileResult =
  | {
      ok: true;
      role: "owner" | "admin" | "senior" | "receptionist" | "nail_tech";
      salon: Record<string, unknown>;
    }
  | { ok: false; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function loadSalonMemberOperationalProfile(
  supabase: RequestSupabaseClient,
  salonId: string,
): Promise<SalonMemberOperationalProfileResult> {
  const { data, error } = await supabase.rpc(
    "load_salon_member_operational_profile" as never,
    { p_salon_id: salonId } as never,
  );
  if (error) return { ok: false, code: "rpc_error" };

  const record = asRecord(data);
  if (!record || record.success !== true || record.code !== "loaded") {
    return {
      ok: false,
      code:
        record && typeof record.code === "string"
          ? record.code
          : "invalid_response",
    };
  }
  if (
    record.role !== "owner" &&
    record.role !== "admin" &&
    record.role !== "senior" &&
    record.role !== "receptionist" &&
    record.role !== "nail_tech"
  ) {
    return { ok: false, code: "invalid_response" };
  }
  const salon = asRecord(record.salon);
  if (!salon || String(salon.id ?? "") !== salonId) {
    return { ok: false, code: "invalid_response" };
  }
  return { ok: true, role: record.role, salon };
}

/**
 * Load the curated management-settings projection defined by
 * `20260820233000_harden_authenticated_salon_column_access.sql`.
 *
 * The database function independently re-checks the active auth session and
 * exact owner/admin membership. Keeping that boundary in the database avoids
 * restoring broad authenticated SELECT access to `public.salons` merely so a
 * Server Component can render management settings.
 */
export async function loadSalonOwnerAdminSettings(
  supabase: RequestSupabaseClient,
  salonId: string,
): Promise<SalonOwnerAdminSettingsResult> {
  const { data, error } = await supabase.rpc(
    "load_salon_owner_admin_settings" as never,
    { p_salon_id: salonId } as never,
  );
  if (error) {
    return { ok: false, code: "rpc_error" };
  }

  const record = asRecord(data);
  if (!record) {
    return { ok: false, code: "invalid_response" };
  }
  if (record.success !== true || record.code !== "loaded") {
    return {
      ok: false,
      code: typeof record.code === "string" ? record.code : "invalid_response",
    };
  }
  if (record.role !== "owner" && record.role !== "admin") {
    return { ok: false, code: "invalid_response" };
  }
  const settings = asRecord(record.settings);
  if (!settings) {
    return { ok: false, code: "invalid_response" };
  }

  return {
    ok: true,
    role: record.role,
    settings,
  };
}

/** Preserve the explicitly pinned demo-owner path without weakening the RPC. */
export async function loadSalonOwnerAdminSettingsForDashboardContext(ctx: {
  kind: "member" | "demo_cookie";
  role: string;
  salon: { id: string };
  supabase: unknown;
}): Promise<SalonOwnerAdminSettingsResult> {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    return { ok: false, code: "forbidden" };
  }
  if (ctx.kind === "member") {
    return loadSalonOwnerAdminSettings(
      ctx.supabase as RequestSupabaseClient,
      ctx.salon.id,
    );
  }

  const { data, error } = await createServiceRoleClient()
    .from("salons")
    .select(SALON_OWNER_ADMIN_SETTINGS_SELECT)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  if (error || !data) return { ok: false, code: "service_error" };
  return {
    ok: true,
    role: ctx.role,
    settings: data as unknown as SalonOwnerAdminSettings,
  };
}
