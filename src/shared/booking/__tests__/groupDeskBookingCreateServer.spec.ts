import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ rpc }) }));
import { createDeskGroupBookingsAuthoritative } from "../groupDeskBookingCreateServer";
import { claimPartySlot, editPartyClaimDetails } from "../partyLinkActions";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const actor = uuid(1);
const request = {
  salonId: uuid(2), idempotencyKey: uuid(3), expectedPricingFingerprint: "a".repeat(64),
  applyEmailDiscount: false, voucherCode: null,
  bookings: [0, 1].map((n) => ({
    serviceId: uuid(4), staffId: uuid(5 + n), clientName: `Synthetic Guest ${n}`,
    clientPhone: `1703555017${n}`, startTimeUtc: "2026-10-01T10:00:00.000Z", endTimeUtc: "2026-10-01T10:30:00.000Z",
  })),
};
function receipt() {
  const members = request.bookings.map((b, n) => ({
    member_index: n, service_id: b.serviceId, staff_id: b.staffId, start_time_utc: b.startTimeUtc, end_time_utc: b.endTimeUtc,
    addon_service_ids: [], addon_lines: [], first_addon_id: null, trailing_buffer_minutes: 0, promo_id: null, promo_name: null,
    original_price_cents: 2000, promo_discount_cents: 0, email_discount_cents: 0, service_pre_voucher_cents: 2000,
    addon_pre_voucher_cents: 0, pre_voucher_subtotal_cents: 2000, voucher_discount_cents: 0, price_cents: 2000,
    addon_price_cents: 0, subtotal_cents: 2000, tax_cents: 0, total_cents: 2000, tax_breakdown: [],
  }));
  return {
    success: true, code: "booked", pricing_fingerprint: request.expectedPricingFingerprint, salon_id: request.salonId,
    group_size: 2, group_id: uuid(7), booking_ids: [uuid(8), uuid(9)], idempotent: false, currency: "CAD", voucher_id: null,
    original_price_cents: 4000, promo_discount_cents: 0, email_discount_cents: 0, voucher_discount_cents: 0,
    pre_voucher_subtotal_cents: 4000, subtotal_cents: 4000, tax_cents: 0, total_cents: 4000, tax_breakdown: [], member_quotes: members,
  };
}

describe("authenticated desk CRM boundary", () => {
  beforeEach(() => rpc.mockReset());

  it("forwards a separately supplied actor to the tenant-authorized wrapper with canonical pricing and member contacts", async () => {
    rpc.mockResolvedValue({ data: receipt(), error: null });
    await expect(createDeskGroupBookingsAuthoritative(request, actor)).resolves.toMatchObject({ ok: true, bookingIds: [uuid(8), uuid(9)] });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("create_group_bookings_for_desk", expect.objectContaining({
      p_salon_id: request.salonId, p_actor_user_id: actor, p_client_phone: request.bookings[0].clientPhone,
      p_expected_pricing_fingerprint: request.expectedPricingFingerprint, p_apply_email_discount: false,
      p_bookings: expect.arrayContaining([expect.objectContaining({ client_phone: request.bookings[1].clientPhone })]),
    }));
  });

  it("rejects actor injection in public input and invalid actors before calling SQL", async () => {
    await expect(createDeskGroupBookingsAuthoritative({ ...request, actorUserId: actor }, actor)).resolves.toEqual({ ok: false, code: "invalid_request" });
    await expect(createDeskGroupBookingsAuthoritative(request, "service_role")).resolves.toEqual({ ok: false, code: "invalid_request" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([{ applyEmailDiscount: true }, { voucherCode: "PHONE" }, { otpSessionId: uuid(10) }, { cardSourceId: "synthetic-not-a-card" }])(
    "does not treat desk authority as SMS/card proof: %j", async (extra) => {
      await expect(createDeskGroupBookingsAuthoritative({ ...request, ...extra }, actor)).resolves.toEqual({ ok: false, code: "invalid_request" });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("fails closed when SQL rejects actor/tenant binding and does not fall back to a public mutation", async () => {
    rpc.mockResolvedValue({ data: { success: false, code: "actor_unauthorized" }, error: null });
    await expect(createDeskGroupBookingsAuthoritative(request, actor)).resolves.toEqual({ ok: false, code: "create_unavailable" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate booking IDs in a successful-looking receipt", async () => {
    rpc.mockResolvedValue({ data: { ...receipt(), booking_ids: [uuid(8), uuid(8)] }, error: null });
    await expect(createDeskGroupBookingsAuthoritative(request, actor)).resolves.toEqual({ ok: false, code: "pricing_invalid" });
  });
});

describe("Party card contact review recovery reason", () => {
  beforeEach(() => rpc.mockReset());
  it.each([claimPartySlot, editPartyClaimDetails])("keeps the review reason visible to the caller", async (action) => {
    rpc.mockResolvedValue({ data: { success: false, code: "contact_change_requires_card_review" }, error: null });
    await expect(action({ token: "synthetic-party-token", claimId: uuid(11), memberName: "Synthetic Guest", memberPhone: "7035550176", reminderOptedIn: false }))
      .resolves.toEqual({ ok: false, reason: "contact_change_requires_card_review" });
  });
});
