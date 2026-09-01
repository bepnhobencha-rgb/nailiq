import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationDeliveryRescueCard,
  notificationDeliveryResolutionCopy,
} from "./NotificationDeliveryRescueCard";

const healthy = {
  available: true,
  smsOutboundEnabled: true,
  emailOutboundEnabled: true,
  smsA2pRegistered: true,
  smsAttentionCount: 0,
  smsSuppressedCount: 0,
  emailAttentionCount: 0,
  waitlistAttentionCount: 0,
  issues: [],
};

const callbacks = {
  onRefresh: vi.fn(),
  onOpenBooking: vi.fn(),
  onOpenWaitlist: vi.fn(),
};

describe("NotificationDeliveryRescueCard", () => {
  it("stays calm when every delivery channel is healthy", () => {
    expect(
      renderToStaticMarkup(
        createElement(NotificationDeliveryRescueCard, {
          slug: "qa-salon",
          language: "en",
          summary: healthy,
          refreshing: false,
          ...callbacks,
        }),
      ),
    ).toBe("");
  });

  it("treats a deliberately disabled SMS channel as configuration, not failure", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationDeliveryRescueCard, {
        slug: "qa-salon",
        language: "en",
        summary: { ...healthy, smsOutboundEnabled: false },
        refreshing: false,
        ...callbacks,
      }),
    );

    expect(html).toContain("limited by salon settings");
    expect(html).toContain("SMS is off by salon setting; Email remains available");
    expect(html).toContain("/dashboard/qa-salon/settings");
    expect(html).not.toContain("customers may not have received");
    expect(html).not.toContain('role="alert"');
  });

  it("offers exact PII-free case review while preserving booking truth", () => {
    const html = renderToStaticMarkup(
      createElement(NotificationDeliveryRescueCard, {
        slug: "qa-salon",
        language: "vi",
        summary: {
          ...healthy,
          smsAttentionCount: 1,
          issues: [
            {
              issueKey: "sms:11111111-1111-4111-8111-111111111111",
              channel: "sms",
              destination: "booking",
              bookingId: "22222222-2222-4222-8222-222222222222",
              waitlistEntryId: null,
              notificationKind: "booking_confirmation",
              status: "unknown",
              resolution: "reconcile_required",
              reasonCode: "outcome_not_confirmed",
              occurredAt: "2026-08-31T22:00:00.000Z",
              bookingDate: "2026-09-01",
            },
          ],
        },
        refreshing: false,
        ...callbacks,
      }),
    );

    expect(html).toContain("notification-delivery-rescue-card");
    expect(html).toContain("lịch hẹn vẫn an toàn");
    expect(html).toContain("1 SMS cần xử lý");
    expect(html).toContain("Xem 1 trường hợp");
    expect(html).not.toContain("22222222-2222-4222-8222-222222222222");
    expect(html).not.toMatch(/@|\+1\d{10}/);
  });

  it("explains automatic retry and unknown-outcome reconciliation truthfully", () => {
    expect(
      notificationDeliveryResolutionCopy("auto_retry_scheduled", "vi"),
    ).toContain("tự gửi lại an toàn");
    expect(
      notificationDeliveryResolutionCopy("reconcile_required", "vi"),
    ).toContain("tránh gửi trùng");
    expect(
      notificationDeliveryResolutionCopy("manual_follow_up", "en"),
    ).toContain("verified fallback");
  });
});
