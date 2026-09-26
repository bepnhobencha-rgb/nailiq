import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { PaymentProvider } from "@/shared/integrations/payments";
import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseBookingPaymentOperationMaterial, type ClaimedBookingPaymentOperation } from "../bookingPaymentOperations";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.resolve }));
import {
  claimReadyFeePaymentReconciliations,
  preflightFeePaymentReconciliation,
  preflightProviderForClaim,
} from "../preflightFeePaymentReconciliation";

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const noShow = { kind: "noshow_charge", purpose: "approved_no_show_charge" } as const;
const cancellation = { kind: "late_cancel_charge", purpose: "approved_cancellation_fee" } as const;
function candidate(kind = "noshow_charge", id = operationId, provider = "square") {
  const account = provider === "square" ? "merchant-1" : "acct_1";
  const location = provider === "square" ? "location-1" : null;
  const environment = provider === "square" ? "sandbox" : null;
  return {
    id, salon_id: salonId, operation_kind: kind, provider,
    material_fingerprint: "b".repeat(64),
    material_json: {
      salon_id: salonId, booking_id: bookingId, operation_kind: kind, provider,
      provider_account_fingerprint: createHash("sha256").update(`${provider}:${account}:${location ?? ""}:${environment ?? ""}`).digest("hex"),
      amount_cents: 2500, currency: "CAD", parent_payment_id: null,
      captured_cents: 2500, refunded_cents: 0, reserved_cents: 0, remaining_refundable_cents: 0,
      ...(kind === "late_cancel_charge" ? {
        operation_occurrence_version: 1, scope_kind: "booking_own",
        cancel_preview: { will_charge: true, has_chargeable_card: true, fee_cents: 2500, currency: "CAD", review_kind: "late" },
      } : {}),
      provider_material: {
        provider_account_id: account, provider_location_id: location, provider_environment: environment,
        currency: "CAD", saved_card_id: "qa-card", customer_id: "qa-customer",
      },
    },
  };
}
function provider(kind: "square" | "stripe" = "square") {
  return { kind, assertPaymentIdentity: vi.fn(), chargeSavedCard: vi.fn(), refund: vi.fn(),
    saveCardOnFile: vi.fn(), removeSavedCard: vi.fn(), findSavedCardByPhone: vi.fn() } satisfies PaymentProvider;
}
function database(rows: unknown[] = []) {
  const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const query = { select: vi.fn(), eq: vi.fn(), lt: vi.fn(), or: vi.fn(), order: vi.fn(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }) };
  for (const key of ["select", "eq", "lt", "or", "order"] as const) query[key].mockReturnValue(query);
  const from = vi.fn().mockReturnValue(query);
  return { db: { from, rpc } as unknown as ReturnType<typeof createServiceRoleClient>, rpc, from, query };
}
function claimFor(row = candidate()): ClaimedBookingPaymentOperation {
  return { operationId: row.id, attemptToken: bookingId, providerIdempotencyKey: `nq:${row.id}`,
    leaseExpiresAt: "2026-09-25T22:00:00Z", attemptCount: 2,
    material: parseBookingPaymentOperationMaterial({ ...row.material_json, material_fingerprint: row.material_fingerprint }, row.operation_kind as "noshow_charge")! };
}

beforeEach(() => vi.clearAllMocks());
describe("fee reconciliation before leasing", () => {
  it("does no read, configuration lookup or claim when release scopes are empty", async () => {
    const { db, from, rpc } = database();
    const result = await preflightFeePaymentReconciliation(db, []);
    await claimReadyFeePaymentReconciliations(db, result);
    expect(from).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("preserves attempt budget through repeated config outages by never claiming", async () => {
    const { db, rpc } = database([candidate()]);
    mocks.resolve.mockRejectedValue(new Error("config unavailable"));
    for (let i = 0; i < 5; i++) {
      const result = await preflightFeePaymentReconciliation(db, [noShow]);
      await claimReadyFeePaymentReconciliations(db, result);
      expect(result.unresolved).toBe(1); expect(result.ready.size).toBe(0);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("filters tenant boolean allowlists, live leases, exhausted and customer-present rows before the bounded scan", async () => {
    const { db, query } = database();
    await preflightFeePaymentReconciliation(db, [noShow, cancellation]);
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("salons!inner(feature_flags)"));
    expect(query.eq).toHaveBeenCalledWith("salons.feature_flags->approved_no_show_charge_dispatch", true);
    expect(query.eq).toHaveBeenCalledWith("salons.feature_flags->approved_cancellation_fee_dispatch", true);
    expect(query.lt).toHaveBeenCalledWith("attempt_count", 3);
    expect(query.or).toHaveBeenCalledWith("delivery_mode.is.null,delivery_mode.neq.public_customer_present");
    expect(query.or).toHaveBeenCalledWith(expect.stringMatching(/^and\(status.in.\(sending,reconciling\),lease_expires_at.lte\..*and\(status.in.\(pending_provider,unknown\),or\(lease_expires_at.is.null,lease_expires_at.lte\..*or\(next_reconcile_at.lte\..*next_reconcile_at.is.null,updated_at.lte\./));
    expect(query.limit).toHaveBeenCalledWith(50);
  });
  it("resolves once per salon/purpose/provider and checks each immutable account binding", async () => {
    const rows = [candidate(), candidate("noshow_charge", bookingId)];
    const { db, rpc } = database(rows); const readyProvider = provider();
    mocks.resolve.mockResolvedValue(readyProvider);
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(salonId, { strict: true, purpose: noShow.purpose });
    expect(readyProvider.assertPaymentIdentity).toHaveBeenCalledTimes(2);
    expect(readyProvider.assertPaymentIdentity).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: "merchant-1", providerLocationId: "location-1", providerEnvironment: "sandbox", providerCurrency: "CAD" }));
    expect(rpc).not.toHaveBeenCalled();
    await claimReadyFeePaymentReconciliations(db, result);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("discover_due_ready_fee_payment_reconciliations", { p_operation_ids: [operationId, bookingId], p_operation_kinds: ["noshow_charge"], p_limit: 25 });
    expect(readyProvider.chargeSavedCard).not.toHaveBeenCalled();
  });
  it("does not share a failed no-show cache entry with cancellation for the same salon", async () => {
    const { db, query } = database();
    query.limit.mockResolvedValueOnce({ data: [candidate()], error: null }).mockResolvedValueOnce({ data: [candidate("late_cancel_charge", bookingId)], error: null });
    mocks.resolve.mockRejectedValueOnce(new Error("no-show gate unavailable")).mockResolvedValueOnce(provider());
    const result = await preflightFeePaymentReconciliation(db, [noShow, cancellation]);
    expect(mocks.resolve).toHaveBeenCalledTimes(2); expect(result.unresolved).toBe(1);
    expect([...result.ready.keys()]).toEqual([bookingId]);
  });
  it("keeps the shared worker budget: no remaining slot means no lease, smaller budget is forwarded", async () => {
    const { db, rpc } = database([candidate()]); mocks.resolve.mockResolvedValue(provider());
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    await claimReadyFeePaymentReconciliations(db, result, 0);
    expect(rpc).not.toHaveBeenCalled();
    await claimReadyFeePaymentReconciliations(db, result, 3);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("discover_due_ready_fee_payment_reconciliations", expect.objectContaining({ p_limit: 3 }));
  });
  it.each([-1, 26, 1.5, Number.NaN])("rejects invalid budget %s without a lease", async (limit) => {
    const { db, rpc } = database([candidate()]); mocks.resolve.mockResolvedValue(provider());
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    await claimReadyFeePaymentReconciliations(db, result, limit);
    expect(rpc).not.toHaveBeenCalled(); expect(result.unresolved).toBe(1);
  });
  it("does not share provider kinds within the same salon/purpose cache", async () => {
    const { db } = database([candidate(), candidate("noshow_charge", bookingId, "stripe")]);
    mocks.resolve.mockResolvedValueOnce(provider()).mockResolvedValueOnce(provider("stripe"));
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    expect(mocks.resolve).toHaveBeenCalledTimes(2); expect(result.ready.size).toBe(2);
  });
  it.each(["null", "wrong kind", "missing identity check", "stale binding"])("never claims with %s configuration", async (reason) => {
    const { db, rpc } = database([candidate()]);
    const configured = provider();
    if (reason === "stale binding") configured.assertPaymentIdentity.mockImplementation(() => { throw new Error("identity mismatch"); });
    mocks.resolve.mockResolvedValue(reason === "null" ? null : reason === "wrong kind" ? provider("stripe") : reason === "missing identity check" ? { ...configured, assertPaymentIdentity: undefined } : configured);
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    await claimReadyFeePaymentReconciliations(db, result);
    expect(result.unresolved).toBe(1); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["query error", "query throw", "malformed response"])("reports %s without a lease", async (reason) => {
    const { db, rpc, query } = database();
    if (reason === "query throw") query.limit.mockRejectedValue(new Error("timeout"));
    else query.limit.mockResolvedValue({ data: reason === "query error" ? [] : null, error: reason === "query error" ? {} : null });
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    await claimReadyFeePaymentReconciliations(db, result);
    expect(result.unresolved).toBe(1); expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects malformed or cross-tenant material before resolving configuration", async () => {
    const row = candidate(); row.salon_id = bookingId;
    const { db, rpc } = database([row, { ...candidate(), material_json: {} }]);
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    await claimReadyFeePaymentReconciliations(db, result);
    expect(result.unresolved).toBe(2); expect(rpc).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("reports saturated scans explicitly instead of silently hiding a queue behind unavailable config", async () => {
    const { db } = database(Array.from({ length: 50 }, () => candidate()));
    mocks.resolve.mockResolvedValue(null);
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    expect(result.scanLimitReached).toBe(true); expect(result.unresolved).toBe(51);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
  it.each(["error", "throw", "malformed"])("reports claim %s without falling back to broad discovery", async (reason) => {
    const { db, rpc } = database([candidate()]); mocks.resolve.mockResolvedValue(provider());
    if (reason === "throw") rpc.mockRejectedValue(new Error("db timeout"));
    else rpc.mockResolvedValue({ data: reason === "malformed" ? {} : [], error: reason === "error" ? {} : null });
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    await claimReadyFeePaymentReconciliations(db, result);
    expect(result.unresolved).toBe(1); expect(result.claims).toEqual([]); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("only returns the preflighted provider for the exact immutable claim including card and amount", async () => {
    const { db } = database([candidate()]); const configured = provider(); mocks.resolve.mockResolvedValue(configured);
    const result = await preflightFeePaymentReconciliation(db, [noShow]);
    const claim = claimFor();
    expect(preflightProviderForClaim(result, claim)).toBe(configured);
    for (const mutate of [
      (c: ClaimedBookingPaymentOperation) => { c.operationId = bookingId; },
      (c: ClaimedBookingPaymentOperation) => { c.material.materialFingerprint = "c".repeat(64); },
      (c: ClaimedBookingPaymentOperation) => { c.material.salonId = bookingId; },
      (c: ClaimedBookingPaymentOperation) => { c.material.provider = "stripe"; },
      (c: ClaimedBookingPaymentOperation) => { c.material.operationKind = "late_cancel_charge"; },
      (c: ClaimedBookingPaymentOperation) => { c.material.providerMaterial.savedCardId = "other-card"; },
      (c: ClaimedBookingPaymentOperation) => { c.material.providerMaterial.providerAccountId = "other-merchant"; },
      (c: ClaimedBookingPaymentOperation) => { c.material.amountCents = 5000; },
    ]) {
      const changed = structuredClone(claim); mutate(changed);
      expect(preflightProviderForClaim(result, changed)).toBeNull();
    }
  });
});
