import "server-only";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { resolvePublicBookingPage } from "@/shared/booking/resolvePublicBookingPage";
import { normalizeBookingClosedDateList } from "@/shared/booking/parseBookingClosedDates";
import { isCocoSetupExperienceVisible } from "@/shared/dashboard/cocoSetupActivation";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { salonDateOffset, salonToday } from "@/shared/lib/salonTime";

export type GuidedBookingPreviewData = {
  slug: string;
  salon: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
    brandColor: string;
    openingHoursRaw: unknown;
    bookingClosedDates: string[];
    bookingLeadMinutes: number;
    resourcesEnabled: boolean;
    staffSelectionEnabled: boolean;
    taxLines: Array<{ name: string; rate: number; enabled: boolean }>;
  };
  previewWindow: { firstDateYmd: string; lastDateYmd: string };
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    durationMinutes: number;
    bufferMinutes: number;
    totalMinutes: number;
    priceDisplay: string | null;
  }>;
  staff: Array<{
    id: string;
    name: string;
    jobRole: string;
  }>;
  capabilityRows: Array<{ staffId: string; serviceId: string }> | null;
};

export type LoadGuidedBookingPreviewResult =
  | { ok: true; data: GuidedBookingPreviewData }
  | {
      ok: false;
      reason: "unauthorized" | "disabled" | "unavailable";
    };

/**
 * Authenticated read boundary for the Guided booking preview.
 *
 * The public booking resolver is reused for its canonical, customer-visible
 * catalog. Only inert display data crosses this boundary: no booking action,
 * provider SDK, OTP route, payment state, or notification dispatcher is
 * imported here. The caller must remain an owner/admin of the exact salon.
 */
export async function loadGuidedBookingPreview(
  slug: string,
): Promise<LoadGuidedBookingPreviewResult> {
  if (typeof slug !== "string" || !slug.trim()) {
    return { ok: false, reason: "unauthorized" };
  }

  try {
    const ctx = await getDashboardWriteClient(slug);
    if (
      !ctx ||
      ctx.kind !== "member" ||
      !isOwnerOrAdmin(ctx.role)
    ) {
      return { ok: false, reason: "unauthorized" };
    }
    if (!(await isCocoSetupExperienceVisible(ctx.salon))) {
      return { ok: false, reason: "disabled" };
    }

    const resolved = await resolvePublicBookingPage(slug);
    if (resolved.status !== "ok") {
      return { ok: false, reason: "unavailable" };
    }
    if (String(resolved.load.salon.id) !== String(ctx.salon.id)) {
      return { ok: false, reason: "unavailable" };
    }
    // The current proof intentionally certifies only the individual,
    // base-service path. Do not silently approve a catalog whose public flow
    // also offers add-ons or combos that this simulator does not exercise.
    if (
      resolved.load.proofComplete !== true ||
      resolved.load.hasActivePromotions !== false ||
      resolved.load.salon.groupBookingEnabled === true ||
      !Array.isArray(resolved.load.addOns) ||
      !Array.isArray(resolved.load.combos) ||
      resolved.load.addOns.length > 0 ||
      resolved.load.combos.length > 0 ||
      resolved.load.services.some((service) => Boolean(service.promoId))
    ) {
      return { ok: false, reason: "unavailable" };
    }
    const serviceIds = new Set(
      resolved.load.services.map((service) => String(service.id)),
    );
    const staffIds = new Set(
      resolved.load.staff.map((staff) => String(staff.id)),
    );
    const capabilityRows = resolved.load.capabilityRows?.filter(
      (row) =>
        staffIds.has(String(row.staff_id)) &&
        serviceIds.has(String(row.service_id)),
    ) ?? null;
    const publicCatalogComplete =
      serviceIds.size > 0 &&
      staffIds.size > 0 &&
      capabilityRows !== null &&
      capabilityRows.length > 0 &&
      [...serviceIds].every((serviceId) =>
        capabilityRows.some(
          (row) => String(row.service_id) === serviceId,
        ),
      );
    if (!publicCatalogComplete) {
      return { ok: false, reason: "unavailable" };
    }
    // Both window edges must use the same instant. Separate implicit `now`
    // reads can straddle salon midnight and produce a mismatched date range.
    const previewNowIso = new Date().toISOString();

    return {
      ok: true,
      data: {
        slug: resolved.normalizedSlug,
        salon: {
          id: String(resolved.load.salon.id),
          name: resolved.load.salon.name,
          address: resolved.load.salon.address,
          phone: resolved.load.salon.salonPhone,
          timezone: resolved.load.salon.timezone,
          brandColor: resolved.load.salon.brandColor,
          openingHoursRaw: resolved.load.salon.opening_hours,
          bookingClosedDates: normalizeBookingClosedDateList(
            resolved.load.salon.booking_closed_dates,
          ),
          bookingLeadMinutes: resolved.load.salon.bookingLeadMinutes,
          resourcesEnabled: resolved.load.salon.resourcesEnabled,
          staffSelectionEnabled: resolved.load.salon.staffSelectionEnabled,
          taxLines: resolved.load.salon.taxLines,
        },
        previewWindow: {
          firstDateYmd: salonToday(
            resolved.load.salon.timezone,
            previewNowIso,
          ),
          lastDateYmd: salonDateOffset(
            resolved.load.salon.timezone,
            59,
            previewNowIso,
          ),
        },
        services: resolved.load.services.map((service) => ({
          id: service.id,
          name: service.name,
          description: service.description,
          durationMinutes: service.durationMinutes,
          bufferMinutes: service.bufferMinutes,
          totalMinutes: service.totalMinutes,
          priceDisplay: service.priceDisplay,
        })),
        staff: resolved.load.staff.map((staff) => ({
          id: staff.id,
          name: staff.name,
          jobRole: staff.job_role,
        })),
        capabilityRows:
          capabilityRows.map((row) => ({
            staffId: row.staff_id,
            serviceId: row.service_id,
          })),
      },
    };
  } catch (error) {
    console.error("[loadGuidedBookingPreview]", {
      errorPresent: Boolean(error),
    });
    return { ok: false, reason: "unavailable" };
  }
}
