import { describe, expect, it } from "vitest";
import { groupFeeNeedsSafetyReview } from "../groupFeeSafety";
import { getUserMessages } from "@/shared/i18n/user";
import { feeActionError } from "@/components/dashboard/FeeCollectionConfirmation";

const blocked = [
  "group_fee_consent_invalid",
  "group_fee_amount_exceeds_cap",
  "group_fee_provider_binding_changed",
  "group_fee_snapshot_invalid",
  "group_fee_consent_changed",
] as const;

describe("group fee safety disclosure", () => {
  it.each(blocked)("explains %s as blocked before payment, with owner review", (reason) => {
    expect(groupFeeNeedsSafetyReview(reason)).toBe(true);
    for (const lang of ["en", "vi"] as const) {
      const messages = getUserMessages(lang).receptionist;
      expect(feeActionError(reason, lang === "vi")).toBe(messages.notify.groupFeeSafetyBlocked);
      expect(messages.partyCard.cancelFeeSafetyBlocked).toBe(messages.notify.groupFeeSafetyBlocked);
      expect(messages.notify.groupFeeSafetyBlocked).not.toBe(messages.notify.groupFeeNotApplicable);
    }
    expect(feeActionError(reason, false)).toContain("owner review. No payment was sent.");
    expect(feeActionError(reason, true)).toContain("chủ tiệm cần kiểm tra");
  });

  it.each([undefined, "outside_fee_window", "policy_disabled", "short_notice_grace_active", "card_or_consent_missing"])(
    "preserves existing non-applicable handling for %s", (reason) => {
      expect(groupFeeNeedsSafetyReview(reason)).toBe(false);
    },
  );

  it.each(["provider_response_lost", "reconciliation_required", "unknown", "in_flight"])(
    "never tells staff no payment was sent for uncertain outcome %s", (reason) => {
      expect(groupFeeNeedsSafetyReview(reason)).toBe(false);
      expect(feeActionError(reason, false)).not.toContain("No payment was sent");
      expect(feeActionError(reason, true)).not.toContain("Chưa gửi lệnh thanh toán");
    },
  );
});
