export type BookingStatus = "pending" | "confirmed" | "completed";

export type SalonDashboardBooking = {
  id: string;
  client_name: string;
  client_phone: string;
  start_time_utc: string;
  status: BookingStatus;
  service_name: string;
  price_cents: number;
};
