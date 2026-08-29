import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(resolve(
  root,
  "supabase/migrations/20260829050000_add_no_show_fee_approval_truth.sql",
), "utf8");
const actions = readFileSync(resolve(
  root,
  "src/shared/noshow/noShowFeeApprovalActions.ts",
), "utf8");
const release = readFileSync(resolve(
  root,
  "src/shared/release/v1IntegrationScope.ts",
), "utf8");
const timeline = readFileSync(resolve(
  root,
  "src/components/receptionist/StaffTimelineGrid.tsx",
), "utf8");

describe("no-show fee approval boundary", () => {
  it("keeps attendance, approval, and payment as separate durable states", () => {
    expect(migration).toContain("CREATE TABLE public.booking_no_show_fee_reviews");
    expect(migration).toContain("CREATE TABLE public.booking_no_show_fee_approval_receipts");
    expect(migration).toContain("no_show_decision_id uuid NOT NULL UNIQUE");
    expect(migration).toMatch(/action text NOT NULL CHECK \(action IN \('charge', 'waive'\)\)/);
    expect(migration).toContain("'approved_not_dispatched'");
    expect(migration).toContain("booking_no_show_fee_approval_receipts_immutable");
    expect(migration).toContain("ensure_booking_no_show_fee_review");
    expect(migration).toContain("deposit_already_protects_booking");
  });

  it("allows only owner/admin approval and keeps direct table access service-only", () => {
    expect(migration).toMatch(/sm\.role IN \('owner', 'admin'\)/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.booking_no_show_fee_reviews,[\s\S]*?FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/);
  });

  it("requires an environment switch, salon allowlist, and SQL receipt before provider dispatch", () => {
    expect(release).toContain("NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH");
    expect(actions).toMatch(/if \(!allowsApprovedNoShowChargeDispatch\(\)\)[\s\S]*?dispatch_release_disabled/);
    expect(actions).toMatch(/approved_no_show_charge_dispatch !== true[\s\S]*?salon_not_allowlisted/);
    expect(actions).toMatch(/authorize_approved_no_show_fee_dispatch[\s\S]*?runAuthoritativeBookingPaymentOperation/);
    expect(actions).toMatch(/stableApprovalRequestId\(input\.reviewId, input\.action\)/);
  });

  it("does not promise a charge action when no callback exists", () => {
    expect(timeline).toContain("fee needs owner review");
    expect(timeline).not.toContain("Unpaid ${amountStr} — tap to charge");
    expect(timeline).not.toContain("Chưa thu ${amountStr} — bấm để thu");
  });
});

describe("Square payment webhook truth", () => {
  it("stores deduplicated revisions and applies only exact provider-bound operations", () => {
    expect(migration).toContain("CREATE TABLE public.square_payment_webhook_inbox");
    expect(migration).toContain("UNIQUE (provider_account_fingerprint, event_id)");
    expect(migration).toContain("provider_binding_mismatch");
    expect(migration).toContain("stale_event_ignored");
    expect(migration).toContain("revision_conflict");
    expect(migration).toMatch(/operation_kind = 'noshow_charge'/);
    expect(release).toContain("NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION");
  });
});
