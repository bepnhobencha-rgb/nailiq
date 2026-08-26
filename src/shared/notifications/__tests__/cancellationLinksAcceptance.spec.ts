import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildReminderEmailHtml } from "@/shared/noshow/sendReminderEmail";
import {
  buildStaffActionEmailSubject,
  buildStaffActionSms,
} from "@/shared/notifications/staffActionMessages";

describe("MQA-0095 cancellation-email acceptance", () => {
  it("has localized cancellation subject/body with service, time, and salon", () => {
    const vars = {
      customerName: "Mai",
      salonName: "Salon QA",
      serviceName: "Signature Head Spa",
      whenLabel: "Fri, Aug 21 at 11:00 AM",
      salonPhone: null,
    };

    expect(buildStaffActionEmailSubject("cancel", "en", vars.salonName)).toBe(
      "Appointment cancelled — Salon QA",
    );
    expect(buildStaffActionSms("cancel", "en", vars)).toContain(
      "Signature Head Spa appointment at Salon QA (Fri, Aug 21 at 11:00 AM) has been cancelled",
    );
    expect(buildStaffActionEmailSubject("cancel", "vi", vars.salonName)).toBe(
      "Lịch hẹn đã huỷ — Salon QA",
    );
    expect(buildStaffActionSms("cancel", "vi", vars)).toContain(
      "lịch hẹn Signature Head Spa của bạn tại Salon QA (Fri, Aug 21 at 11:00 AM) đã được huỷ",
    );
  });
});

describe("MQA-0099 customer action-link acceptance", () => {
  it("renders bounded reminder routes and percent-encodes the capability token", () => {
    const html = buildReminderEmailHtml(
      {
        salonId: "11111111-1111-4111-8111-111111111111",
        confirmToken: "confirm&next=https://evil.example",
        rescheduleToken: "reschedule&next=https://evil.example",
        cancelToken: "cancel&next=https://evil.example",
        clientName: "Mai",
        clientEmail: "mai@example.test",
        serviceName: "Signature Head Spa",
        staffName: "Anna",
        startTimeUtc: "2099-08-21T18:00:00.000Z",
        salonName: "Salon QA",
        salonSlug: "salon-qa",
      },
      "Your appointment is tomorrow.",
    );

    expect(html).toContain("/booking/confirm?token=confirm%26next%3Dhttps%3A%2F%2Fevil.example");
    expect(html).toContain("/booking/reschedule?token=reschedule%26next%3Dhttps%3A%2F%2Fevil.example");
    expect(html).toContain("/booking/cancel?token=cancel%26next%3Dhttps%3A%2F%2Fevil.example");
    expect(html).not.toContain("token=confirm&next=");
  });

  it.todo(
    "email-link GET is preview-only and explicit POST performs confirmation",
  );
  it.todo(
    "confirm, reschedule, cancel, and card-management capabilities have independent scopes",
  );
  it.todo(
    "using Confirm does not invalidate Reschedule or Cancel from the same reminder",
  );
  it.todo(
    "a requested appointment-long expiry is never shortened by reuse of a 48-hour token",
  );
  it.todo(
    "concurrent token minting leaves one authoritative usable capability per scope",
  );
  it.todo(
    "a reschedule/cancel transition revokes every stale action capability for the old state",
  );
  it.todo(
    "the public booking-status URL uses a bounded capability rather than a permanent naked booking id",
  );
});
