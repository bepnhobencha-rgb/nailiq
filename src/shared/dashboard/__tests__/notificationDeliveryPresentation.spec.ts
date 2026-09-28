import { describe, expect, it } from "vitest";

import { notificationDeliveryPresentation } from "@/shared/dashboard/notificationDeliveryPresentation";

describe("owner activity notification delivery labels", () => {
  it("does not claim provider acceptance means customer delivery", () => {
    for (const status of ["sent", "accepted", "queued"]) {
      const presentation = notificationDeliveryPresentation(status);
      expect(presentation.tone).toBe("warning");
      expect(presentation.label).toBe("⏳ Chờ xác nhận giao");
    }
  });

  it("distinguishes provider-reported delivery from customer reading", () => {
    const presentation = notificationDeliveryPresentation("delivered");
    expect(presentation).toMatchObject({
      label: "✓ Đã giao",
      tone: "success",
    });
    expect(presentation.detail).toContain("không xác nhận khách đã đọc");
  });

  it("distinguishes rejection, non-delivery, suppression and uncertainty", () => {
    expect(notificationDeliveryPresentation("failed").label).toBe("✗ Gửi thất bại");
    expect(notificationDeliveryPresentation("undelivered").label).toBe("✗ Không giao được");
    expect(notificationDeliveryPresentation("suppressed").label).toBe("— Không gửi");
    expect(notificationDeliveryPresentation("sending").label).toBe("⏳ Đang gửi");
    for (const status of ["unknown", "pending", "unrecognized"]) {
      expect(notificationDeliveryPresentation(status)).toMatchObject({
        label: "? Chưa xác minh",
        tone: "warning",
      });
    }
  });
});
