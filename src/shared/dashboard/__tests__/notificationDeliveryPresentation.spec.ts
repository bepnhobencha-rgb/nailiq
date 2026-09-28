import { describe, expect, it } from "vitest";

import { notificationDeliveryPresentation } from "@/shared/dashboard/notificationDeliveryPresentation";

describe("owner activity notification delivery labels", () => {
  it("does not claim provider acceptance means customer delivery", () => {
    for (const status of ["sent", "accepted"]) {
      const presentation = notificationDeliveryPresentation(status);
      expect(presentation.tone).toBe("warning");
      expect(presentation.label).toBe("⏳ Chờ xác nhận giao");
      expect(presentation.detail).not.toContain("Nhà cung cấp đã nhận");
    }
  });

  it("does not claim a queued message has reached the provider", () => {
    expect(notificationDeliveryPresentation("queued")).toMatchObject({
      label: "⏳ Chờ gửi",
      tone: "warning",
    });
    expect(notificationDeliveryPresentation("queued").detail).toContain("chưa có bằng chứng nhà cung cấp đã nhận");
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
