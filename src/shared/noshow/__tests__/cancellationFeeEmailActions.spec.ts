import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), service: vi.fn(), from: vi.fn(), group: vi.fn(), late: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("../groupCancellationFeeApprovalActions", () => ({ decideGroupCancellationFeeReview: mocks.group }));
vi.mock("../lateCancellationFeeApprovalActions", () => ({ decideLateCancellationFeeReview: mocks.late }));
vi.mock("../cancellationFeeDispatchActions", () => ({ dispatchApprovedCancellationFee: mocks.dispatch }));
import { confirmCancellationFeeFromEmail, loadCancellationFeeEmailReview, waiveCancellationFeeFromEmail } from "../cancellationFeeEmailActions";

const salonId = "fc260927-0000-4000-8000-000000000001";
const bookingId = "fc260927-0000-4000-8000-000000000010";
const reviewId = "fc260927-0000-4000-8000-000000000020";
const input = { salonId, bookingId, reviewId, reviewKind: "group" as const,
  amountCents: 2500, currency: "CAD", cardBrand: "VISA", cardLast4: "1111", consentPolicyVersion: "v1" };
let review: Record<string, unknown>;
let kind: "late" | "group";
let missingBooking: boolean;
let queryError: boolean;
let queries: Array<{ table: string; filters: Array<[string, unknown]>; columns: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  kind = "group"; missingBooking = false; queryError = false; queries = [];
  review = { id: reviewId, amount_cents: 2500, currency: "CAD", card_brand: "VISA", card_last4: "1111", consent_policy_version: "v1", state: "pending_review", payment_status: "not_authorized" };
  mocks.context.mockResolvedValue({ kind: "member", userId: "qa-owner", role: "owner", salon: { id: salonId, name: "E2E QA", timezone: "America/Vancouver" } });
  mocks.service.mockReturnValue({ from: mocks.from });
  mocks.from.mockImplementation((table: string) => {
    const query = { table, filters: [] as Array<[string, unknown]>, columns: "" };
    queries.push(query);
    const result = () => queryError ? { data: null, error: { message: "PII SECRET" } } : {
      data: table === "bookings" ? missingBooking ? null : { id: bookingId, client_name: "Synthetic QA", start_time_utc: "2026-10-01T16:00:00Z", services: { name: "QA service" } }
        : table.includes(`booking_${kind}_cancellation`) ? [{ ...review }] : [], error: null,
    };
    const chain = {
      select(columns: string) { query.columns = columns; return chain; },
      eq(key: string, value: unknown) { query.filters.push([key, value]); return chain; },
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  });
  const approve = async () => { review.state = "approved_charge"; review.payment_status = "dispatch_blocked"; return { ok: true, state: "approved_charge", paymentStatus: "dispatch_blocked" }; };
  mocks.group.mockImplementation(approve); mocks.late.mockImplementation(approve);
  mocks.dispatch.mockResolvedValue({ ok: true, paymentStatus: "succeeded" });
});

describe("cancellation email destination", () => {
  it("is read-only, salon/booking scoped, and independent of queue pagination", async () => {
    expect(await loadCancellationFeeEmailReview("qa-salon", bookingId)).toMatchObject({ ok: true, salonId, reviews: [{ reviewId, reviewKind: "group", amountCents: 2500 }] });
    expect(queries).toHaveLength(3);
    for (const query of queries) expect(query.filters).toContainEqual(["salon_id", salonId]);
    expect(queries[0].filters).toContainEqual(["id", bookingId]);
    expect(queries[1].filters).toContainEqual(["booking_id", bookingId]);
    expect(queries[2].filters).toContainEqual(["organizer_booking_id", bookingId]);
    expect(queries.map((q) => q.columns).join()).not.toMatch(/phone|email|token|customer_id|card_id/);
    expect(mocks.group).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each([null, { role: "receptionist", kind: "member", userId: "u" }, { role: "owner", kind: "demo_cookie", userId: null }])("denies non-owner sessions before privileged queries: %j", async (ctx) => {
    mocks.context.mockResolvedValue(ctx);
    expect(await loadCancellationFeeEmailReview("qa-salon", bookingId)).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("does not expose a booking from another salon", async () => {
    missingBooking = true;
    expect(await loadCancellationFeeEmailReview("qa-salon", bookingId)).toEqual({ ok: false, error: "not_found" });
    expect(queries).toHaveLength(1);
  });
  it("returns safe unavailable on DB error, not a false no-fee state", async () => {
    queryError = true;
    expect(await loadCancellationFeeEmailReview("qa-salon", bookingId)).toEqual({ ok: false, error: "unavailable" });
  });
  it("rejects malformed route IDs before auth or DB", async () => {
    expect(await loadCancellationFeeEmailReview("qa-salon", "not-id")).toEqual({ ok: false, error: "not_found" });
    expect(mocks.context).not.toHaveBeenCalled();
  });
});

describe("explicit email fee confirmation", () => {
  it.each(["late", "group"] as const)("approves and dispatches %s only on explicit confirmation", async (reviewKind) => {
    kind = reviewKind;
    expect(await confirmCancellationFeeFromEmail("qa-salon", { ...input, reviewKind })).toMatchObject({ ok: true });
    expect(reviewKind === "group" ? mocks.group : mocks.late).toHaveBeenCalledWith("qa-salon", { salonId, reviewId, action: "charge" });
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith("qa-salon", { salonId, reviewId, reviewKind });
  });
  it.each(["amountCents", "currency", "cardBrand", "cardLast4", "consentPolicyVersion"] as const)("rejects stale or tampered %s without approval/payment", async (field) => {
    const changed = { ...input, [field]: field === "amountCents" ? 3000 : field === "currency" ? "USD" : field === "cardLast4" ? "2222" : "changed" };
    expect(await confirmCancellationFeeFromEmail("qa-salon", changed)).toEqual({ ok: false, error: "review_changed" });
    expect(mocks.group).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each(["unknown", "dispatching", "pending_provider", "failed"])("never dispatches a %s outcome", async (status) => {
    review.state = "approved_charge"; review.payment_status = status;
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_collectible" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each(["waived", "not_applicable", "invalidated"])("never collects %s", async (state) => {
    review.state = state;
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_collectible" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("returns an existing succeeded status without invoking a provider", async () => {
    review.state = "approved_charge"; review.payment_status = "succeeded";
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: true, paymentStatus: "succeeded" });
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.group).not.toHaveBeenCalled();
  });
  it("re-reads after approval replay instead of treating historic dispatch_blocked as current", async () => {
    mocks.group.mockImplementation(async () => { review.state = "approved_charge"; review.payment_status = "unknown"; return { ok: true, paymentStatus: "dispatch_blocked" }; });
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_collectible" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("rejects changed material after approval and before dispatch", async () => {
    mocks.group.mockImplementation(async () => { review.state = "approved_charge"; review.payment_status = "dispatch_blocked"; review.amount_cents = 3000; return { ok: true }; });
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_changed" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("propagates approval refusal without payment", async () => {
    mocks.group.mockResolvedValue({ ok: false, error: "review_not_pending" });
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_pending" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("keeps a committed approval when dispatch is unavailable", async () => {
    mocks.dispatch.mockResolvedValue({ ok: false, error: "dispatch_release_disabled" });
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "dispatch_release_disabled" });
    expect(review).toMatchObject({ state: "approved_charge", payment_status: "dispatch_blocked" });
  });
  it("rejects a different salon or review identity", async () => {
    expect(await confirmCancellationFeeFromEmail("qa-salon", { ...input, salonId: bookingId })).toEqual({ ok: false, error: "salon_mismatch" });
    expect(await confirmCancellationFeeFromEmail("qa-salon", { ...input, reviewId: bookingId })).toEqual({ ok: false, error: "review_not_found" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each([{ amountCents: -1 }, { amountCents: 1.1 }, { currency: "bad" }, { cardLast4: "" }, { cardBrand: "" }, { consentPolicyVersion: "" }, { reviewKind: "no-show" }])("validates untrusted inputs: %j", async (change) => {
    expect(await confirmCancellationFeeFromEmail("qa-salon", { ...input, ...change } as typeof input)).toEqual({ ok: false, error: "invalid_request" });
    expect(mocks.context).not.toHaveBeenCalled();
  });
});


describe("explicit email fee waiver", () => {
  beforeEach(() => {
    const waive = async () => { review.state = "waived"; review.payment_status = "not_authorized"; return { ok: true, state: "waived", paymentStatus: "not_authorized" }; };
    mocks.group.mockImplementation(waive); mocks.late.mockImplementation(waive);
  });
  it.each(["late", "group"] as const)("waives %s with a durable decision and no payment", async (reviewKind) => {
    kind = reviewKind;
    review.card_brand = null; review.card_last4 = null;
    expect(await waiveCancellationFeeFromEmail("qa-salon", { ...input, reviewKind })).toEqual({ ok: true, state: "waived" });
    expect(reviewKind === "group" ? mocks.group : mocks.late).toHaveBeenCalledWith("qa-salon", { salonId, reviewId, action: "waive" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("returns a saved waiver idempotently without another mutation", async () => {
    review.state = "waived";
    expect(await waiveCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: true, state: "waived" });
    expect(mocks.group).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each(["dispatch_blocked", "unknown", "dispatching", "pending_provider", "succeeded", "failed"])("cannot waive an approved %s payment", async (status) => {
    review.state = "approved_charge"; review.payment_status = status;
    expect(await waiveCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_waivable" });
    expect(mocks.group).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("reconciles a concurrent winning waiver by read only", async () => {
    mocks.group.mockImplementation(async () => { review.state = "waived"; return { ok: false, error: "review_not_pending" }; });
    expect(await waiveCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: true, state: "waived" });
    expect(mocks.group).toHaveBeenCalledTimes(1); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("does not claim waived when charge wins the decision race", async () => {
    mocks.group.mockImplementation(async () => { review.state = "approved_charge"; review.payment_status = "dispatch_blocked"; return { ok: false, error: "review_not_pending" }; });
    expect(await waiveCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_pending" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("cannot collect after a waiver wins", async () => {
    await waiveCancellationFeeFromEmail("qa-salon", input);
    expect(await confirmCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "review_not_collectible" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("rejects stale amount, wrong salon and wrong review", async () => {
    expect(await waiveCancellationFeeFromEmail("qa-salon", { ...input, amountCents: 100 })).toEqual({ ok: false, error: "review_changed" });
    expect(await waiveCancellationFeeFromEmail("qa-salon", { ...input, salonId: bookingId })).toEqual({ ok: false, error: "salon_mismatch" });
    expect(await waiveCancellationFeeFromEmail("qa-salon", { ...input, reviewId: bookingId })).toEqual({ ok: false, error: "review_not_found" });
    expect(mocks.group).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("rejects an unauthorized actor before privileged read or mutation", async () => {
    mocks.context.mockResolvedValue(null);
    expect(await waiveCancellationFeeFromEmail("qa-salon", input)).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled(); expect(mocks.group).not.toHaveBeenCalled();
  });
  it("rejects invalid identifiers/amount at the boundary", async () => {
    expect(await waiveCancellationFeeFromEmail("qa-salon", { ...input, amountCents: -1 })).toEqual({ ok: false, error: "invalid_request" });
    expect(mocks.context).not.toHaveBeenCalled();
  });
});
