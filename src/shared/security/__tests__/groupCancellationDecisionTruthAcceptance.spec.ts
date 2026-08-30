import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260830221517_add_group_cancellation_decision_truth.sql",
  ),
  "utf8",
);
const desk = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);
const receptionist = readFileSync(
  resolve(process.cwd(), "src/components/receptionist/ReceptionistCenter.tsx"),
  "utf8",
);
const partyCard = readFileSync(
  resolve(process.cwd(), "src/components/receptionist/PartyCardPanel.tsx"),
  "utf8",
);
const localeCopy = ["en", "vi"].map((locale) => readFileSync(
  resolve(process.cwd(), `src/shared/i18n/user/${locale}.ts`),
  "utf8",
)).join("\n");

describe("P0 whole-party cancellation decision truth", () => {
  it("persists one service-only fee review and immutable approval receipt", () => {
    expect(migration).toContain("booking_group_cancel_fee_review_request_once");
    expect(migration).toContain("UNIQUE (salon_id, cancellation_request_id)");
    expect(migration).toContain("booking_group_cancellation_fee_receipts_immutable");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE public\.booking_group_cancellation_fee_reviews\s+TO service_role/,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE public\.booking_group_cancellation_fee_approval_receipts\s+TO service_role/,
    );
  });

  it("requires preview plus a human decision before the atomic cancel", () => {
    expect(desk).toContain("preview_booking_group_cancellation_for_desk");
    expect(desk).toContain("cancel_booking_group_for_desk_with_decision_truth");
    expect(migration).toContain("fee_decision_required");
    expect(migration).toContain("fee_waive_forbidden");
    expect(receptionist).toContain("group-cancel-fee-panel");
    expect(partyCard).toContain("previewDeskGroupCancellation");
  });

  it("never sums duplicate member fee snapshots or dispatches payment/providers", () => {
    expect(migration).toContain("v_organizer.noshow_fee_cents");
    expect(migration).not.toMatch(/sum\s*\(\s*(?:b\.)?noshow_fee_cents/i);
    expect(migration).toContain("dispatch_blocked");
    expect(migration).not.toMatch(/square|twilio|resend|runAuthoritativeBookingPaymentOperation/i);
  });

  it("records queued rather than delivered notification truth", () => {
    expect(desk).toContain('sms: notifySms ? "queued" : "not_requested"');
    expect(desk).toContain('email: notifyEmail ? "queued" : "not_requested"');
    expect(localeCopy).toContain("delivery not yet confirmed");
    expect(localeCopy).toContain("chưa xác nhận đã nhận");
  });
});
