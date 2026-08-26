"use server";

// CRUD server actions for staff_shifts (recurring weekly schedule) and
// staff_unavailability (one-off blocked dates).
// Callers: StaffShiftHub admin settings panel.
// Auth: owner/admin only. This module backs the management Settings surface;
// operational staff must not reach it by replaying the exported Server Actions.

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type DayOfWeek = (typeof VALID_DAYS)[number];

const TIME_RE = /^\d{2}:\d{2}$/;

// ─── Staff listing (for the shift grid) ──────────────────────────────────────

export interface StaffSummary {
  id: string;
  name: string;
  job_role: string;
}

export async function listActiveStaff(
  slug: string,
): Promise<{ ok: boolean; data?: StaffSummary[]; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { data, error } = await ctx.supabase
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", ctx.salon.id)
    .eq("status", "active")
    .order("name");

  if (error) {
    console.error("[listActiveStaff]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, data: (data ?? []) as StaffSummary[] };
}

// ─── Staff Shifts ────────────────────────────────────────────────────────────

export interface StaffShiftRow {
  id: string;
  staff_id: string;
  day_of_week: DayOfWeek;
  start_time: string;
  end_time: string;
  break_start_time: string | null;
  break_end_time: string | null;
  is_active: boolean;
}

export async function listStaffShifts(
  slug: string,
): Promise<{ ok: boolean; data?: StaffShiftRow[]; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { data, error } = await ctx.supabase
    .from("staff_shifts")
    .select("id, staff_id, day_of_week, start_time, end_time, break_start_time, break_end_time, is_active")
    .eq("salon_id", ctx.salon.id)
    .order("staff_id")
    .order("day_of_week");

  if (error) {
    console.error("[listStaffShifts]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, data: (data ?? []) as StaffShiftRow[] };
}

export async function upsertStaffShift(
  slug: string,
  staffId: string,
  dayOfWeek: string,
  startTime: string,
  endTime: string,
  breakStartTime?: string | null,
  breakEndTime?: string | null,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  if (!VALID_DAYS.includes(dayOfWeek as DayOfWeek)) {
    return { ok: false, error: "invalid_day" };
  }
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return { ok: false, error: "invalid_time_format" };
  }
  if (startTime >= endTime) {
    return { ok: false, error: "start_must_be_before_end" };
  }
  const cleanBreakStart = breakStartTime?.trim() || null;
  const cleanBreakEnd = breakEndTime?.trim() || null;
  if ((cleanBreakStart === null) !== (cleanBreakEnd === null)) {
    return { ok: false, error: "break_pair_required" };
  }
  if (
    cleanBreakStart &&
    (!TIME_RE.test(cleanBreakStart) ||
      !TIME_RE.test(cleanBreakEnd ?? "") ||
      startTime >= cleanBreakStart ||
      cleanBreakStart >= (cleanBreakEnd ?? "") ||
      (cleanBreakEnd ?? "") >= endTime)
  ) {
    return { ok: false, error: "invalid_break" };
  }

  // Verify the staff member belongs to this salon
  const { data: staffRow } = await ctx.supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id)
    .single();

  if (!staffRow) return { ok: false, error: "staff_not_found" };

  const { data, error } = await ctx.supabase
    .from("staff_shifts")
    .upsert(
      {
        staff_id: staffId,
        salon_id: ctx.salon.id,
        day_of_week: dayOfWeek,
        start_time: startTime,
        end_time: endTime,
        break_start_time: cleanBreakStart,
        break_end_time: cleanBreakEnd,
        is_active: true,
      },
      { onConflict: "staff_id,day_of_week" },
    )
    .select("id")
    .single();

  if (error) {
    console.error("[upsertStaffShift]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, id: data?.id };
}

export async function deleteStaffShift(
  slug: string,
  shiftId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("staff_shifts")
    .delete()
    .eq("id", shiftId)
    .eq("salon_id", ctx.salon.id);

  if (error) {
    console.error("[deleteStaffShift]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}

// ─── Staff Unavailability ─────────────────────────────────────────────────────

export interface StaffUnavailabilityRow {
  id: string;
  staff_id: string;
  date: string;
  reason: string | null;
}

export async function listStaffUnavailability(
  slug: string,
  fromDate?: string,
  toDate?: string,
): Promise<{ ok: boolean; data?: StaffUnavailabilityRow[]; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  let query = ctx.supabase
    .from("staff_unavailability")
    .select("id, staff_id, date, reason")
    .eq("salon_id", ctx.salon.id)
    .order("date")
    .order("staff_id");

  if (fromDate) query = query.gte("date", fromDate);
  if (toDate) query = query.lte("date", toDate);

  const { data, error } = await query;

  if (error) {
    console.error("[listStaffUnavailability]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, data: (data ?? []) as StaffUnavailabilityRow[] };
}

export async function upsertStaffUnavailability(
  slug: string,
  staffId: string,
  date: string,
  reason?: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "invalid_date_format" };
  }

  const { data: staffRow } = await ctx.supabase
    .from("staff")
    .select("id")
    .eq("id", staffId)
    .eq("salon_id", ctx.salon.id)
    .single();

  if (!staffRow) return { ok: false, error: "staff_not_found" };

  const { data, error } = await ctx.supabase
    .from("staff_unavailability")
    .upsert(
      {
        staff_id: staffId,
        salon_id: ctx.salon.id,
        date,
        reason: reason ?? null,
      },
      { onConflict: "staff_id,date" },
    )
    .select("id")
    .single();

  if (error) {
    console.error("[upsertStaffUnavailability]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, id: data?.id };
}

export async function deleteStaffUnavailability(
  slug: string,
  unavailabilityId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const { error } = await ctx.supabase
    .from("staff_unavailability")
    .delete()
    .eq("id", unavailabilityId)
    .eq("salon_id", ctx.salon.id);

  if (error) {
    console.error("[deleteStaffUnavailability]", error);
    return { ok: false, error: "server_error" };
  }

  return { ok: true };
}
