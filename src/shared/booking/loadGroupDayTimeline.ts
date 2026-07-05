"use server";

/**
 * Visual availability preview for the desk group-booking "Specific time"
 * picker — for every SLOT_STEP_MIN tick across the salon's open hours,
 * reports whether SOME aligned arrangement is feasible for this group
 * (any capable+free staff, not a specific-staff commitment). Tapping a
 * feasible tick in the UI just fills the same `specificTime` value the
 * existing native time input already uses — the real staff assignment is
 * still resolved by the unchanged `loadGroupSmartSchedule` search that
 * runs afterward.
 *
 * Deliberately standalone: duplicates the salon/services/staff/capability/
 * occupancy fetch steps already in `loadGroupSmartSchedule.ts` instead of
 * refactoring that file (which is live and was just fixed) — see that
 * file's steps 1–9 for the canonical version of this fetch shape. Reuses
 * every actual scheduling primitive (`tryAlignedArrangement`,
 * `buildCapabilityMap`, `serviceBlockMinutes`, `minutesToLabel`) so the
 * feasibility math itself is never reimplemented.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/shared/lib/supabase/server";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import {
  buildCapabilityMap,
  isStaffCapableForService,
  type StaffCapabilityMap,
} from "@/shared/booking/staffCapability";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { salonDayRangeUtc, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import { minutesToLabel } from "@/shared/booking/getAvailableTimeSlots";
import {
  SLOT_STEP_MIN,
  tryAlignedArrangement,
  type ExistingBooking,
  type ResolvedMember,
  type StaffRow,
} from "@/shared/booking/groupSchedulerCore";

export type GroupDayTimelineMemberInput = {
  serviceId: string;
  addonServiceIds?: string[];
  /** Customer's preferred staff. `null`/omitted = "Any" (checked against
   *  every capable staff). When set, the sweep reports a tick as feasible
   *  only if THIS staff is free — matching the real scheduler's strict
   *  respect-preferred pass, so the timeline never shows "available" for a
   *  time where the requested staff is actually busy (which would silently
   *  reassign to someone else on submit). */
  preferredStaffId?: string | null;
};

export type GroupDayTimelineParams = {
  shopSlug: string;
  /** YYYY-MM-DD in salon-local time. */
  date: string;
  members: GroupDayTimelineMemberInput[];
};

export type GroupDayTimelineTick = {
  /** "HH:MM" 24h, salon-local — matches the value the native time input uses. */
  time: string;
  /** e.g. "3:30 PM" for display. */
  label: string;
  feasible: boolean;
};

export type GroupDayTimelineResult =
  | { ok: true; timezone: string; ticks: GroupDayTimelineTick[] }
  | {
      ok: false;
      reason:
        | "salon_not_found"
        | "salon_paused"
        | "salon_closed"
        | "timezone_not_set"
        | "invalid_input"
        | "server_error";
    };

function minutesToHm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function loadGroupDayTimeline(
  params: GroupDayTimelineParams,
): Promise<GroupDayTimelineResult> {
  if (!Array.isArray(params.members) || params.members.length < 2) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
    return { ok: false, reason: "invalid_input" };
  }

  const supabase: SupabaseClient = await createClient();

  // 1. Salon ---------------------------------------------------------
  const { data: salonRaw, error: salonErr } = await supabase
    .from("salons")
    .select("id, profile_complete, opening_hours, timezone, booking_closed_dates, booking_lead_minutes")
    .eq("slug", params.shopSlug)
    .maybeSingle();
  if (salonErr || !salonRaw) return { ok: false, reason: "salon_not_found" };
  const salonRow = salonRaw as unknown as {
    id: string;
    profile_complete?: unknown;
    opening_hours?: unknown;
    timezone?: unknown;
    booking_closed_dates?: unknown;
    booking_lead_minutes?: unknown;
  };
  if (!salonRow.profile_complete) return { ok: false, reason: "salon_paused" };

  const rawTimezone =
    typeof salonRow.timezone === "string" ? salonRow.timezone.trim() : "";
  if (rawTimezone.length === 0) return { ok: false, reason: "timezone_not_set" };
  const timezone = rawTimezone;

  const leadMinutesRaw = Number(salonRow.booking_lead_minutes);
  const leadMs =
    (Number.isFinite(leadMinutesRaw) && leadMinutesRaw >= 0
      ? Math.round(leadMinutesRaw)
      : 15) * 60_000;
  const earliestAllowedMs = Date.now() + leadMs;

  // 2. Closed-day + opening hours -------------------------------------
  const closedYmdSet = parseBookingClosedDateSet(salonRow.booking_closed_dates);
  if (closedYmdSet.has(params.date)) return { ok: false, reason: "salon_closed" };

  const openingWeek = parseOpeningHours(salonRow.opening_hours);
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(params.date);
  if (!dateParts) return { ok: false, reason: "invalid_input" };
  const localMidnight = new Date(
    Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3])),
  );
  const dayKey = dayKeyFromLocalDate(localMidnight);
  const dayHours = openingWeek ? openingWeek[dayKey] : null;
  if (!dayHours || dayHours.closed) return { ok: false, reason: "salon_closed" };

  const openMin = hmToMinutes(dayHours.open);
  const closeMin = hmToMinutes(dayHours.close);
  if (closeMin <= openMin) return { ok: false, reason: "salon_closed" };

  // 3. Services → resolved members (no preferred staff — this is a
  //    general go/no-go preview, not a staff-specific commitment) -----
  const serviceIds = Array.from(
    new Set(params.members.map((m) => m.serviceId).filter((id) => !!id)),
  );
  if (serviceIds.length === 0) return { ok: false, reason: "invalid_input" };

  const addonIdSet = new Set<string>();
  for (const m of params.members) {
    for (const aid of m.addonServiceIds ?? []) if (aid) addonIdSet.add(aid);
  }
  const allFetchIds = Array.from(new Set([...serviceIds, ...addonIdSet]));

  const { data: serviceRows, error: svcErr } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, is_addon, addon_timing")
    .in("id", allFetchIds)
    .eq("salon_id", salonRow.id)
    .is("deleted_at" as never, null);
  if (svcErr) return { ok: false, reason: "server_error" };

  const serviceById = new Map<string, { totalMin: number }>();
  type AddonInfo = { block: number; concurrent: boolean };
  const addonById = new Map<string, AddonInfo>();

  for (const r of serviceRows ?? []) {
    const rTyped = r as typeof r & { is_addon?: unknown; addon_timing?: unknown };
    const dur = Number(r.duration_minutes) || 0;
    const buf = Number(r.buffer_minutes) || 0;
    if (rTyped.is_addon === true) {
      addonById.set(String(r.id), {
        block: serviceBlockMinutes(dur, buf),
        concurrent: rTyped.addon_timing === "concurrent",
      });
      continue;
    }
    serviceById.set(String(r.id), { totalMin: serviceBlockMinutes(dur, buf) });
  }

  const resolvedMembers: ResolvedMember[] = [];
  for (let i = 0; i < params.members.length; i++) {
    const m = params.members[i];
    const svc = serviceById.get(m.serviceId);
    if (!svc) return { ok: false, reason: "invalid_input" };

    let addedMin = 0;
    for (const aid of m.addonServiceIds ?? []) {
      const addon = addonById.get(aid);
      if (addon && !addon.concurrent) addedMin += addon.block;
    }

    resolvedMembers.push({
      index: i,
      name: "",
      serviceId: m.serviceId,
      serviceName: "",
      totalMinutes: svc.totalMin + addedMin,
      priceCents: null,
      preferredStaffId: m.preferredStaffId ?? null,
    });
  }

  // 4. Active staff + capability ---------------------------------------
  const { data: staffRows, error: staffErr } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salonRow.id)
    .eq("status", "active")
    .is("deleted_at" as never, null);
  if (staffErr) return { ok: false, reason: "server_error" };
  const staffList: StaffRow[] = (staffRows ?? []).map((s) => ({
    id: String(s.id),
    name: String(s.name ?? ""),
  }));
  if (staffList.length === 0) {
    return { ok: true, timezone, ticks: [] };
  }
  const staffById = new Map<string, StaffRow>();
  for (const s of staffList) staffById.set(s.id, s);

  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", staffList.map((s) => s.id));
  const capabilityRows = (capRows ?? []).map((r) => ({
    staff_id: String(r.staff_id),
    service_id: String(r.service_id),
  }));
  const capability: StaffCapabilityMap =
    capabilityRows.length > 0 ? buildCapabilityMap(capabilityRows) : null;

  // A member can reference a preferred staff that doesn't exist / isn't
  // capable for their service (stale selection). Drop it silently so the
  // sweep falls back to "any capable staff" for that member instead of
  // reporting every tick infeasible — mirrors loadGroupSmartSchedule.ts.
  for (const m of resolvedMembers) {
    if (m.preferredStaffId === null) continue;
    if (!staffById.has(m.preferredStaffId)) m.preferredStaffId = null;
    else if (!isStaffCapableForService(capability, m.preferredStaffId, m.serviceId))
      m.preferredStaffId = null;
  }

  // 5. Existing occupancy for the date ---------------------------------
  const { startUtc, endUtc } = salonDayRangeUtc(params.date, timezone);
  const { data: occRows, error: occErr } = await supabase.rpc(
    "public_booking_occupancy_for_range",
    { p_salon_id: salonRow.id, p_start: startUtc, p_end: endUtc },
  );
  if (occErr) return { ok: false, reason: "server_error" };
  const existing: ExistingBooking[] = ((occRows ?? []) as Array<{
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
  }>).flatMap((row) => {
    if (!row.staff_id) return [];
    const startMs = Date.parse(row.start_time_utc);
    const endMs = Date.parse(row.end_time_utc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    return [{ staffId: String(row.staff_id), startMs, endMs }];
  });

  // 6. Sweep every SLOT_STEP_MIN tick -----------------------------------
  const maxMemberMin = resolvedMembers.reduce(
    (acc, m) => Math.max(acc, m.totalMinutes),
    0,
  );
  const dayCloseMs = Date.parse(salonWallTimeToUtcIso(params.date, closeMin, timezone));
  const ticks: GroupDayTimelineTick[] = [];

  for (let mm = openMin; mm <= closeMin; mm += SLOT_STEP_MIN) {
    const iso = salonWallTimeToUtcIso(params.date, mm, timezone);
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;

    const time = minutesToHm(mm);
    const label = minutesToLabel(mm);

    if (ms < earliestAllowedMs) {
      ticks.push({ time, label, feasible: false });
      continue;
    }
    if (Number.isFinite(dayCloseMs) && ms + maxMemberMin * 60_000 > dayCloseMs) {
      ticks.push({ time, label, feasible: false });
      continue;
    }

    // respectPreferred=true: a member with an explicit preferred staff must
    // have THAT staff free — members left on "Any" (null) still check
    // every capable staff regardless of this flag (see tryAlignedArrangement).
    const aligned = tryAlignedArrangement(
      ms,
      resolvedMembers,
      staffList,
      staffById,
      capability,
      existing,
      true,
    );
    ticks.push({ time, label, feasible: aligned !== null });
  }

  return { ok: true, timezone, ticks };
}
