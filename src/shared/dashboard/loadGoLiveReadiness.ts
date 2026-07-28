import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import {
  evaluateGoLiveReadiness,
  type GoLiveReadiness,
} from "@/shared/dashboard/goLiveReadiness";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type LoadGoLiveReadinessResult =
  | { ok: true; readiness: GoLiveReadiness; salonName: string }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export async function loadGoLiveReadiness(
  slug: string,
): Promise<LoadGoLiveReadinessResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) {
    return { ok: false, reason: "unauthorized" };
  }

  const [salonResult, servicesResult, staffResult] = await Promise.all([
    ctx.supabase
      .from("salons")
      .select(
        "name, address, salon_phone, timezone, opening_hours, profile_complete, email, email_verified, email_links_enabled, phone_otp_enabled",
      )
      .eq("id", ctx.salon.id)
      .maybeSingle(),
    ctx.supabase
      .from("services")
      .select("price_cents, duration_minutes")
      .eq("salon_id", ctx.salon.id)
      .is("deleted_at" as never, null),
    ctx.supabase
      .from("staff")
      .select("*", { count: "exact", head: true })
      .eq("salon_id", ctx.salon.id)
      .eq("status", "active")
      .is("deleted_at" as never, null),
  ]);

  if (salonResult.error || servicesResult.error || staffResult.error) {
    console.error("[loadGoLiveReadiness]", {
      salon: salonResult.error?.code,
      services: servicesResult.error?.code,
      staff: staffResult.error?.code,
    });
    return { ok: false, reason: "unavailable" };
  }

  const row = salonResult.data as
    | {
        name?: unknown;
        address?: unknown;
        salon_phone?: unknown;
        timezone?: unknown;
        opening_hours?: unknown;
        profile_complete?: unknown;
        email?: unknown;
        email_verified?: unknown;
        email_links_enabled?: unknown;
        phone_otp_enabled?: unknown;
      }
    | null;

  if (!row) return { ok: false, reason: "unavailable" };

  const salonName =
    typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : ctx.salon.name || slug;
  const activeServices = (servicesResult.data ?? []).map((service) => {
    const value = service as {
      price_cents?: unknown;
      duration_minutes?: unknown;
    };
    return {
      priceCents:
        typeof value.price_cents === "number" ? value.price_cents : null,
      durationMinutes:
        typeof value.duration_minutes === "number"
          ? value.duration_minutes
          : null,
    };
  });

  return {
    ok: true,
    salonName,
    readiness: evaluateGoLiveReadiness({
      slug,
      name: typeof row.name === "string" ? row.name : null,
      address: typeof row.address === "string" ? row.address : null,
      salonPhone:
        typeof row.salon_phone === "string" ? row.salon_phone : null,
      timezone: row.timezone,
      openingHours: row.opening_hours,
      profileComplete: row.profile_complete === true,
      email: typeof row.email === "string" ? row.email : null,
      emailVerified: row.email_verified === true,
      emailLinksEnabled: row.email_links_enabled !== false,
      phoneOtpEnabled: row.phone_otp_enabled === true,
      activeServices,
      activeStaffCount: staffResult.count ?? 0,
    }),
  };
}
