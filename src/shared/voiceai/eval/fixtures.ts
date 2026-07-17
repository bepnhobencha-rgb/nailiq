/**
 * Deterministic fixtures for the AI-receptionist evaluation harness.
 *
 * Two tenant-isolated salons (SALON_A "Tech Nails", SALON_B "Glossy Nails") plus
 * a MOCK tool executor that returns fixed, salon-scoped results and RECORDS every
 * tool call so the scorer can inspect behaviour. Nothing here touches the network,
 * Supabase, or an API key — it is the fake half of the injected smsAgent loop.
 *
 * The executor is intentionally strict about two things the rubric cares about:
 *  • confirm_booking only succeeds for a time that was ACTUALLY offered by a prior
 *    get_available_slots call (else { error: "invalid_time" }) — so a hallucinated
 *    time is observable, not silently "booked".
 *  • it only ever knows ONE salon's services/staff — it can never return the other
 *    tenant's data.
 */
import type { SalonVoiceContext } from "../loadSalonContext";

// ─── Salon A — "Tech Nails" (English, 6 services incl. variable pricing) ──────

export const SALON_A: SalonVoiceContext = {
  salonId:         "salon-a-0000-0000-0000-techmnails",
  salonName:       "Tech Nails",
  timezone:        "America/Vancouver",
  address:         "123 Fraser Hwy, Langley, BC",
  currency:        "CAD",
  personaName:     "Lily",
  personaVoice:    "marin",
  reasoningEffort: "low",
  businessHours: {
    mon: { open: "09:00", close: "19:00" },
    tue: { open: "09:00", close: "19:00" },
    wed: { open: "09:00", close: "19:00" },
    thu: { open: "09:00", close: "19:00" },
    fri: { open: "09:00", close: "20:00" },
    sat: { open: "09:00", close: "18:00" },
    sun: { closed: true },
  },
  services: [
    { id: "svc-a-manicure",   name: "Manicure",        durationMins: 30, priceCents: 2500, price_type: "fixed", price_max_cents: null },
    { id: "svc-a-gelmani",    name: "Gel Manicure",    durationMins: 45, priceCents: 3500, price_type: "fixed", price_max_cents: null },
    { id: "svc-a-pedicure",   name: "Pedicure",        durationMins: 45, priceCents: 4000, price_type: "fixed", price_max_cents: null },
    { id: "svc-a-deluxepedi", name: "Deluxe Pedicure", durationMins: 60, priceCents: 5500, price_type: "from",  price_max_cents: 8000 },
    { id: "svc-a-shellac",    name: "Shellac",         durationMins: 45, priceCents: 4500, price_type: "fixed", price_max_cents: null },
    { id: "svc-a-acrylic",    name: "Acrylic Full Set", durationMins: 75, priceCents: 6000, price_type: "from",  price_max_cents: 9000 },
  ],
  staff: [
    { id: "stf-a-anna",  name: "Anna" },
    { id: "stf-a-bella", name: "Bella" },
    { id: "stf-a-chloe", name: "Chloe" },
  ],
};

// ─── Salon B — "Glossy Nails" (DIFFERENT tenant, for cross-tenant tests) ──────
// Unique, non-overlapping service/staff names so a leak into Salon A is detectable.

export const SALON_B: SalonVoiceContext = {
  salonId:         "salon-b-1111-1111-1111-glossynails",
  salonName:       "Glossy Nails",
  timezone:        "America/Toronto",
  address:         "88 Queen St W, Toronto, ON",
  currency:        "CAD",
  personaName:     "Mai",
  personaVoice:    "marin",
  reasoningEffort: "low",
  businessHours: {
    mon: { open: "10:00", close: "18:00" },
    sun: { closed: true },
  },
  services: [
    { id: "svc-b-facial",   name: "Signature Spa Facial", durationMins: 60, priceCents: 8000, price_type: "fixed", price_max_cents: null },
    { id: "svc-b-dippowder", name: "Dip Powder Set",      durationMins: 60, priceCents: 5000, price_type: "fixed", price_max_cents: null },
    { id: "svc-b-classicpedi", name: "Classic Pedi",      durationMins: 40, priceCents: 3800, price_type: "fixed", price_max_cents: null },
  ],
  staff: [
    { id: "stf-b-diana", name: "Diana" },
    { id: "stf-b-emma",  name: "Emma" },
  ],
};

export const SALONS = { A: SALON_A, B: SALON_B } as const;
export type SalonKey = keyof typeof SALONS;

/** Substrings unique to a salon — used to detect cross-tenant leakage in transcripts. */
export function tenantFingerprints(salon: SalonVoiceContext): string[] {
  return [salon.salonName, ...salon.services.map((s) => s.name), ...salon.staff.map((s) => s.name)];
}

// ─── Mock tool executor ───────────────────────────────────────────────────────

export type ToolCallRecord = { name: string; input: Record<string, unknown>; result: unknown };

export type MockOptions = {
  /** A date (YYYY-MM-DD) that is fully booked — get_available_slots returns count 0. */
  fullDate?: string;
  /** Force confirm_booking / confirm_group_booking to fail once with a conflict (recovery tests). */
  conflictOnConfirm?: boolean;
  /** Make verify_otp always reject (otp-failure tests). */
  otpAlwaysFail?: boolean;
};

/** Default slot labels offered for any open date. */
const DEFAULT_SLOTS = ["10:00 AM", "11:30 AM", "2:00 PM", "3:30 PM"];

export type MockExecutor = {
  /** The injectable tool executor (matches smsAgent's ToolExecutor signature). */
  callTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Every (name, input, result) tuple, in call order. */
  calls: ToolCallRecord[];
  /** Union of every time label ever returned by get_available_slots / group slots. */
  offeredSlots: Set<string>;
};

/**
 * Build a deterministic, salon-scoped tool executor. Returns { callTool, calls,
 * offeredSlots } — the harness injects callTool into runSmsAgent and the scorer
 * reads calls + offeredSlots.
 */
export function makeMockToolExecutor(salon: SalonVoiceContext, opts: MockOptions = {}): MockExecutor {
  const calls: ToolCallRecord[] = [];
  const offeredSlots = new Set<string>();
  const serviceIds = new Set(salon.services.map((s) => s.id));
  const staffIds = new Set(salon.staff.map((s) => s.id));
  let bookingSeq = 0;
  let conflictArmed = opts.conflictOnConfirm === true;

  const record = (name: string, input: Record<string, unknown>, result: unknown): unknown => {
    calls.push({ name, input, result });
    return result;
  };

  const knownService = (id: unknown): boolean => typeof id === "string" && serviceIds.has(id);
  const knownStaff = (id: unknown): boolean =>
    id === undefined || id === "any" || (typeof id === "string" && staffIds.has(id));

  const callTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "get_available_slots": {
        if (!knownService(input.service_id)) return record(name, input, { error: "unknown_service" });
        if (!knownStaff(input.staff_id)) return record(name, input, { error: "unknown_staff" });
        const full = opts.fullDate && input.date === opts.fullDate;
        const slots = full ? [] : DEFAULT_SLOTS;
        for (const s of slots) offeredSlots.add(s);
        return record(name, input, { slots, count: slots.length, date: input.date });
      }

      case "confirm_booking": {
        if (!knownService(input.service_id)) return record(name, input, { error: "unknown_service" });
        const time = String(input.time_slot ?? "");
        if (!offeredSlots.has(time)) return record(name, input, { error: "invalid_time" });
        if (conflictArmed) {
          conflictArmed = false;
          return record(name, input, { error: "slot_conflict", message: "That slot was just taken." });
        }
        bookingSeq += 1;
        return record(name, input, {
          success: true,
          bookingId: `${salon.salonId}-bk-${bookingSeq}`,
          service_id: input.service_id,
          date: input.date,
          time_slot: time,
        });
      }

      case "find_booking": {
        return record(name, input, {
          bookings: [
            {
              booking_id: `${salon.salonId}-existing-1`,
              service: salon.services[0]?.name ?? "Manicure",
              date: "2026-07-19",
              time: "2:00 PM",
              staff: salon.staff[0]?.name ?? "Any",
              is_group_booking: false,
            },
          ],
        });
      }

      case "cancel_booking": {
        // Lookup mode: only a phone provided → return details, do NOT cancel yet.
        if (!input.booking_id && !input.group_id && input.customer_phone) {
          return record(name, input, {
            confirmation_required: true,
            booking_id: `${salon.salonId}-existing-1`,
            service: salon.services[0]?.name ?? "Manicure",
            date: "2026-07-19",
            time: "2:00 PM",
            is_group_booking: false,
          });
        }
        return record(name, input, { success: true, cancelled: true });
      }

      case "reschedule_booking": {
        const time = String(input.new_time_slot ?? "");
        if (!offeredSlots.has(time)) return record(name, input, { error: "invalid_time" });
        return record(name, input, {
          success: true,
          booking_id: input.booking_id,
          new_date: input.new_date,
          new_time_slot: time,
        });
      }

      case "request_otp": {
        return record(name, input, { success: true, sent: true, message: "A 6-digit code was sent." });
      }

      case "verify_otp": {
        const ok = !opts.otpAlwaysFail && String(input.code ?? "") === "123456";
        return record(name, input, ok
          ? { success: true, otp_session_id: `${salon.salonId}-otp-sess` }
          : { error: "invalid_code", message: "That code is incorrect." });
      }

      case "get_group_available_slots": {
        const assignments = Array.isArray(input.service_assignments) ? input.service_assignments : [];
        const anyUnknown = assignments.some(
          (a) => !knownService((a as { service_id?: unknown }).service_id),
        );
        if (anyUnknown) return record(name, input, { error: "unknown_service" });
        offeredSlots.add("2:00 PM");
        return record(name, input, {
          isWaveOption: false,
          options: [{ start: "2:00 PM", end: "3:30 PM", groupStart: "14:00", groupEnd: "15:30" }],
        });
      }

      case "confirm_group_booking": {
        if (conflictArmed) {
          conflictArmed = false;
          return record(name, input, { error: "slot_no_longer_available" });
        }
        return record(name, input, {
          success: true,
          group_id: `${salon.salonId}-grp-1`,
          party_link: `https://nailiq.ca/party/${salon.salonId}`,
          start_time: "2:00 PM",
          end_time: "3:30 PM",
        });
      }

      case "join_waitlist": {
        if (!knownService(input.service_id)) return record(name, input, { error: "unknown_service" });
        return record(name, input, { success: true, waitlisted: true });
      }

      case "end_call": {
        return record(name, input, { success: true, ended: true });
      }

      default:
        return record(name, input, { error: "unknown_tool" });
    }
  };

  return { callTool, calls, offeredSlots };
}
