import { describe, expect, it } from "vitest";

import {
  buildBookingConfirmationSms,
  buildReviewRequestSms,
  buildSaveCardSms,
  buildWaitlistSms,
  estimateSmsSegments,
  isSmsTemplateEnabled,
} from "@/shared/lib/smsTemplateRegistry";

describe("unified SMS template registry", () => {
  it("never allows required booking receipts to be disabled", () => {
    expect(isSmsTemplateEnabled("booking_confirmation", {
      booking_confirmation: false,
    })).toBe(true);
    expect(isSmsTemplateEnabled("review_request", {
      review_request: false,
    })).toBe(false);
  });

  it("builds one-language booking truth with management affordance", () => {
    const body = buildBookingConfirmationSms({
      lang: "vi",
      salonName: "Hi-Lite Head Spa",
      dateLabel: "9:00, Thứ Hai",
      serviceName: "Hi-Lite Classic",
      manageUrl: "https://nailiq.ca/booking/status?token=safe",
    });
    expect(body).toContain("Đã xác nhận Hi-Lite Classic");
    expect(body).toContain("Xem hoặc đổi lịch:");
    expect(body).not.toContain("Booked");
  });

  it("does not overstate card charging policy", () => {
    const body = buildSaveCardSms({
      lang: "en",
      salonName: "Hi-Lite Studio",
      url: "https://nailiq.ca/card",
    });
    expect(body).toContain("No charge now");
    expect(body).toContain("policy you accepted");
    expect(body).not.toContain("only charged if you no-show");
  });

  it("states waitlist truth and uses professional Vietnamese review copy", () => {
    expect(buildWaitlistSms({
      lang: "en",
      salonName: "Hi-Lite Studio",
      serviceName: "Classic",
      claimUrl: "https://nailiq.ca/claim",
    })).toContain("not booked until you confirm");
    const review = buildReviewRequestSms({
      lang: "vi",
      salonName: "Hi-Lite Studio",
      reviewUrl: "https://nailiq.ca/review",
    });
    expect(review).toContain("Chia sẻ trải nghiệm");
    expect(review).not.toContain("Reply STOP");
  });

  it("estimates GSM and Unicode segment counts for admin preview", () => {
    expect(estimateSmsSegments("Hello")).toEqual({
      encoding: "GSM-7",
      units: 5,
      segments: 1,
    });
    expect(estimateSmsSegments("Cảm ơn").encoding).toBe("UCS-2");
    expect(estimateSmsSegments("é").encoding).toBe("GSM-7");
  });
});
