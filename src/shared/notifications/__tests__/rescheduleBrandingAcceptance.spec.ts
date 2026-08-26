import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildHtml } from "@/shared/booking/sendBookingConfirmationEmail";
import {
  buildStaffActionEmailSubject,
  buildStaffActionSms,
} from "@/shared/notifications/staffActionMessages";

const confirmationInput = {
  bookingId: "00000000-0000-4000-8000-000000000001",
  shopSlug: "qa-salon",
  clientName: "Mai",
  clientEmail: "mai@example.test",
  serviceName: "Signature Head Spa",
  staffName: "Anna",
  startTimeUtc: "2026-08-21T18:00:00.000Z",
  totalPriceCents: 9_000,
};

describe("MQA-0096 reschedule customer-email acceptance", () => {
  it("has localized customer copy with the authoritative new time", () => {
    const vars = {
      customerName: "Mai",
      salonName: "Salon QA",
      serviceName: "Signature Head Spa",
      whenLabel: "Fri, Aug 21 at 11:00 AM",
      salonPhone: null,
    };

    expect(
      buildStaffActionEmailSubject("reschedule", "en", vars.salonName),
    ).toBe("Appointment rescheduled — Salon QA");
    expect(buildStaffActionSms("reschedule", "en", vars)).toContain(
      "has been moved to Fri, Aug 21 at 11:00 AM",
    );
    expect(
      buildStaffActionEmailSubject("reschedule", "vi", vars.salonName),
    ).toBe("Lịch hẹn đã được dời — Salon QA");
    expect(buildStaffActionSms("reschedule", "vi", vars)).toContain(
      "đã được dời sang: Fri, Aug 21 at 11:00 AM",
    );
  });
});

describe("MQA-0098 email branding acceptance", () => {
  it("currently has a safe escaped salon-name fallback", () => {
    const html = buildHtml(
      '<script>alert("x")</script> Salon QA',
      confirmationInput,
      "Fri, Aug 21 at 11:00 AM",
      "https://nailiq.ca/qa-salon/wait/booking",
      "USD",
      null,
    );

    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Salon QA",
    );
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain(
      ">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Salon QA</span>",
    );
    expect(html).not.toContain(">NailIQ</span>");
  });
});
