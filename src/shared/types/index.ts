export type BookingStatus = "pending" | "confirmed" | "completed";

export type SalonDashboardBooking = {
  id: string;
  client_name: string;
  client_phone: string;
  start_time_utc: string;
  status: BookingStatus;
  service_name: string;
  /** Assigned staff display name when present. */
  staff_name: string | null;
  price_cents: number;
};
