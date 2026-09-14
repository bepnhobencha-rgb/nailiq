import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: vi.fn(), provider: vi.fn(), card: vi.fn(), persist: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("../looseDb", () => ({ looseServiceClient: mocks.db }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));
vi.mock("@/shared/booking/persistExistingSquareCardReceipt", () => ({ persistExistingSquareCardReceipt: mocks.persist }));
vi.mock("@/shared/booking/cardCapturePause", () => ({ isCardCapturePaused: () => false }));
import { reuseNoShowCardForBooking } from "../noshow";

const BOOKING = "10000000-0000-4000-8000-000000000031";
const SESSION = "10000000-0000-4000-8000-000000000032";
const SALON = "10000000-0000-4000-8000-000000000033";
const OTHER = "10000000-0000-4000-8000-000000000034";
const NOW = new Date("2026-09-13T12:00:00Z");
type Row = Record<string, unknown>;
let session: Row;
let booking: Row;
let sessionError: boolean;
function db() {
  return { from(table: string) {
    let columns = "";
    const execute = () => {
      if (table === "phone_otp_sessions") return { data: session, error: sessionError ? { code: "synthetic_read_error" } : null };
      if (table === "bookings") return { data: columns === "status" ? [] : booking, error: null };
      if (table === "salons") return { data: { name: "Synthetic Salon", currency_code: "CAD", cancellation_policy: {
        en: "Cancel at least 24 hours before the appointment. A missed visit may incur the disclosed fee.",
        vi: "Vui lòng huỷ trước giờ hẹn ít nhất 24 giờ. Lịch vắng có thể chịu mức phí đã công bố.",
      },
        noshow_protection_enabled: true, noshow_fee_percent: 20, noshow_require_new_customer: true }, error: null };
      throw new Error("Unexpected table " + table);
    };
    const query = {
      select: (value: string) => { columns = value; return query; }, eq: () => query, not: () => query,
      limit: () => query, maybeSingle: async () => execute(), then: (resolve: (v: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    return query;
  } };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real network forbidden"); }));
  sessionError = false;
  booking = { id: BOOKING, salon_id: SALON, client_phone: "16045550931", otp_session_id: SESSION,
    noshow_card_id: null, noshow_card_required: true, card_protection_status: "awaiting_card", price_cents: 5000 };
  session = { id: SESSION, salon_id: SALON, phone: "+16045550931", verified_channel: "sms",
    verified_at: "2026-09-13T11:00:00Z", expires_at: "2026-09-13T11:10:00Z",
    consumed_at: "2026-09-13T11:01:00Z", consumed_by_booking_id: BOOKING };
  mocks.db.mockImplementation(db);
  mocks.provider.mockResolvedValue({ kind: "square", findSavedCardByPhone: mocks.card });
  mocks.card.mockResolvedValue({ cardId: "synthetic-card", customerId: "synthetic-customer", brand: "VISA", last4: "1111" });
  mocks.persist.mockResolvedValue(true);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.useRealTimers();
});
describe("existing card reuse after atomic booking SMS consumption", () => {
  it("accepts exact booking-bound proof consumed during TTL, even on a delayed request", async () => {
    expect(await reuseNoShowCardForBooking(BOOKING, SESSION, true)).toMatchObject({ ok: true, reason: "reused" });
    expect(mocks.card).toHaveBeenCalledWith("16045550931");
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING, salonId: SALON, source: "explicit_reuse" }));
  });
  it("retains an active unconsumed SMS path", async () => {
    session.consumed_at = null; session.consumed_by_booking_id = null;
    session.expires_at = "2026-09-13T12:05:00Z";
    expect(await reuseNoShowCardForBooking(BOOKING, SESSION, true)).toMatchObject({ ok: true });
  });
  it.each([
    { consumed_by_booking_id: OTHER }, { consumed_by_booking_id: null }, { id: OTHER }, { salon_id: OTHER },
    { phone: "16045550932" }, { verified_channel: "email" }, { verified_channel: "staff_attested" },
    { verified_at: "invalid" }, { expires_at: "invalid" }, { consumed_at: "invalid" },
    { consumed_at: "2026-09-13T10:59:00Z" }, { consumed_at: "2026-09-13T11:10:00Z" },
    { consumed_at: "2026-09-13T12:01:00Z", expires_at: "2026-09-13T12:05:00Z" },
    { consumed_at: null, consumed_by_booking_id: null },
    { consumed_at: null, expires_at: "2026-09-13T12:05:00Z" },
  ])("rejects mismatching or invalid proof without a card lookup: %j", async patch => {
    Object.assign(session, patch);
    expect(await reuseNoShowCardForBooking(BOOKING, SESSION, true)).toMatchObject({ ok: false });
    expect(mocks.card).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("requires the booking itself to retain the exact consumed session binding", async () => {
    booking.otp_session_id = OTHER;
    expect(await reuseNoShowCardForBooking(BOOKING, SESSION, true)).toMatchObject({ ok: false });
    expect(mocks.card).not.toHaveBeenCalled();
  });
  it("does not authorize from a data row returned alongside a read error", async () => {
    sessionError = true;
    expect(await reuseNoShowCardForBooking(BOOKING, SESSION, true)).toMatchObject({ ok: false });
    expect(mocks.card).not.toHaveBeenCalled();
  });
  it("retains the explicit consent gate", async () => {
    expect(await reuseNoShowCardForBooking(BOOKING, SESSION, false)).toMatchObject({ ok: false });
    expect(mocks.db).not.toHaveBeenCalled(); expect(mocks.card).not.toHaveBeenCalled();
  });
});
