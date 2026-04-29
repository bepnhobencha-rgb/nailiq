import { createClient } from "@/shared/lib/supabase/client";

export type OccupancyInterval = {
  staffId: string;
  startMs: number;
  endMs: number;
};

type OccRow = {
  staff_id: string;
  start_time_utc: string;
  end_time_utc: string;
};

export async function fetchBookingOccupancyForRange(
  salonId: string,
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<OccupancyInterval[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: salonId,
    p_start: rangeStartIso,
    p_end: rangeEndIso,
  });

  if (error || !Array.isArray(data)) return [];

  return (data as OccRow[]).map((row) => ({
      staffId: String(row.staff_id),
      startMs: new Date(row.start_time_utc).getTime(),
      endMs: new Date(row.end_time_utc).getTime(),
    }));
}
