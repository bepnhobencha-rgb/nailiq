import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NotificationDeliveryRescueCard } from "./NotificationDeliveryRescueCard";

const healthy = {
  available: true,
  smsOutboundEnabled: true,
  emailOutboundEnabled: true,
  smsA2pRegistered: true,
  smsAttentionCount: 0,
  smsSuppressedCount: 0,
  emailAttentionCount: 0,
  waitlistAttentionCount: 0,
};

describe("NotificationDeliveryRescueCard", () => {
  it("stays calm when every delivery channel is healthy", () => {
    expect(renderToStaticMarkup(
      <NotificationDeliveryRescueCard
        slug="qa-salon"
        language="en"
        summary={healthy}
        refreshing={false}
        onRefresh={vi.fn()}
      />,
    )).toBe("");
  });

  it("shows channel and durable delivery failures without exposing PII", () => {
    const html = renderToStaticMarkup(
      <NotificationDeliveryRescueCard
        slug="qa-salon"
        language="vi"
        summary={{
          ...healthy,
          smsOutboundEnabled: false,
          smsAttentionCount: 2,
          waitlistAttentionCount: 1,
        }}
        refreshing={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(html).toContain("notification-delivery-rescue-card");
    expect(html).toContain("SMS đang tắt");
    expect(html).toContain("2 SMS cần kiểm tra");
    expect(html).toContain("1 thông báo Waitlist cần cứu");
    expect(html).toContain("/dashboard/qa-salon/settings");
    expect(html).not.toMatch(/@|\+1\d{10}/);
  });
});
