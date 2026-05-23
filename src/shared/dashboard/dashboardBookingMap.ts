import type {
  BookingSource,
  BookingStatus,
  SalonDashboardBooking,
} from "@/shared/types";

/** Matches `loadSalonOwnerDashboard` / client hydrate fetch. */
export const DASHBOARD_BOOKING_SELECT =
  "id, client_name, client_phone, client_notes, start_time_utc, status, source, price_cents, verification_method, sms_confirmation_sent_at, sms_confirmation_failed_at, no_show_risk_score, services!bookings_service_id_fkey ( name, price_cents ), staff ( name )";

const ALL_VALID_STATUSES: BookingStatus[] = [
  "pending",
  "confirmed",
  "completed",
  "waiting",
  "in_progress",
  "cancelled",
];

type ServiceJoinRow = { name: string; price_cents: number };

type StaffJoinRow = { name: string };

export type BookingRowDb = {
  id: string;
  client_name: string;
  client_phone: string | null;
  client_notes?: string | null;
  start_time_utc: string | null;
  status: string;
  source?: string | null;
  price_cents: number | null;
  verification_method?: string | null;
  sms_confirmation_sent_at?: string | null;
  sms_confirmation_failed_at?: string | null;
  no_show_risk_score?: number | null;
  services: ServiceJoinRow | ServiceJoinRow[] | null;
  staff: StaffJoinRow | StaffJoinRow[] | null;
};

function serviceFromJoin(
  raw: ServiceJoinRow | ServiceJoinRow[] | null,
): ServiceJoinRow | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

function staffFromJoin(
  raw: StaffJoinRow | StaffJoinRow[] | null,
): StaffJoinRow | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

export function mapDashboardBookingRow(row: BookingRowDb): SalonDashboardBooking {
  const status = row.status as BookingStatus;
  const safeStatus: BookingStatus = ALL_VALID_STATUSES.includes(status)
    ? status
    : "pending";
  const svc = serviceFromJoin(row.services);
  const st = staffFromJoin(row.staff);
  const price = row.price_cents ?? svc?.price_cents ?? 0;
  return {
    id: row.id,
    client_name: row.client_name,
    client_phone: row.client_phone,
    client_notes: (() => {
      const n = row.client_notes;
      if (n == null) return null;
      const s = String(n).trim();
      return s.length > 0 ? s : null;
    })(),
    start_time_utc: row.start_time_utc,
    status: safeStatus,
    source: (row.source === "walkin" ? "walkin" : "appointment") as BookingSource,
    service_name: svc?.name ?? "—",
    staff_name: st?.name?.trim() ? String(st.name).trim() : null,
    price_cents: Number(price),
    verification_method: row.verification_method ?? null,
    sms_confirmation_sent_at: row.sms_confirmation_sent_at ?? null,
    sms_confirmation_failed_at: row.sms_confirmation_failed_at ?? null,
    no_show_risk_score: row.no_show_risk_score != null ? Number(row.no_show_risk_score) : null,
  };
}
