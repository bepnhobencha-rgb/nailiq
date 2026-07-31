export type OwnerHomeStaffStatus = {
  name: string;
  status: "busy" | "available";
};

type StaffRow = {
  id: string;
  name: string | null;
};

type BookingRow = {
  staff_id: string | null;
  status: string;
  start_time_utc: string | null;
  end_time_utc: string | null;
};

/**
 * Builds the owner-home "right now" staff snapshot using the same occupancy
 * contract as the receptionist availability engine:
 * - an in-progress service remains busy even after its planned end;
 * - a confirmed booking is busy only while its scheduled window covers now.
 */
export function buildOwnerHomeStaffSnapshot(input: {
  staff: StaffRow[];
  bookings: BookingRow[];
  nowMs: number;
}): OwnerHomeStaffStatus[] {
  return input.staff.map((staff) => {
    const busy = input.bookings.some((booking) => {
      if (booking.staff_id !== staff.id) return false;
      if (booking.status === "in_progress") return true;
      if (booking.status !== "confirmed") return false;

      const startMs = booking.start_time_utc
        ? Date.parse(booking.start_time_utc)
        : Number.NaN;
      const endMs = booking.end_time_utc
        ? Date.parse(booking.end_time_utc)
        : Number.NaN;

      return (
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        startMs <= input.nowMs &&
        endMs > input.nowMs
      );
    });

    return {
      name: staff.name?.trim() || "—",
      status: busy ? "busy" : "available",
    };
  });
}
