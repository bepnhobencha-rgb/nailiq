import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildCustomerAppointmentEmail } from "../staffActionEmailTemplate";

describe("customer appointment email template", () => {
  it("renders a professional, mobile-first English confirmation without duplicating the subject", () => {
    const rendered = buildCustomerAppointmentEmail({
      event: "create",
      locale: "en",
      subject: "Appointment confirmed — Hi-Lite Head Spa",
      recipientEmail: "john@example.com",
      clientName: "John <Tran>",
      salonName: "Hi-Lite Head Spa",
      salonSlug: "hilite-anaheim",
      salonPhone: "714-537-1075",
      serviceName: "Hi-Lite <Classic>",
      staffName: "Anna & Bee",
      whenLabel: "Tue, Sep 1, 9:00 AM",
      siteUrl: "https://nailiq.test",
    });

    expect(rendered).not.toBeNull();
    expect(rendered?.html).toContain("Your appointment is all set");
    expect(rendered?.html).toContain("John &lt;Tran&gt;");
    expect(rendered?.html).toContain("Hi-Lite &lt;Classic&gt;");
    expect(rendered?.html).not.toContain("<Classic>");
    expect(rendered?.html).toContain("Date & time");
    expect(rendered?.html).toContain("Anna &amp; Bee");
    expect(rendered?.html).toContain("https://nailiq.test/hilite-anaheim");
    expect(rendered?.html).toContain("https://nailiq.test/hilite-anaheim/booking-terms");
    expect(rendered?.html).toContain("NailIQ Booking Check");
    expect(rendered?.html).toContain("no time, price, or policy is invented by AI");
    expect(rendered?.html).toContain("Manage optional emails");
    expect(rendered?.html.match(/Appointment confirmed — Hi-Lite Head Spa/g)).toHaveLength(1);
    expect(rendered?.text).toContain("Salon: Hi-Lite Head Spa");
    expect(rendered?.text).toContain("Call salon: 714-537-1075");
  });

  it("makes cancellation payment truth explicit in English and Vietnamese", () => {
    const en = buildCustomerAppointmentEmail({
      event: "cancel",
      locale: "en",
      subject: "Appointment cancelled — NailIQ QA",
      recipientEmail: "guest@example.com",
      clientName: "Guest",
      salonName: "NailIQ QA",
      salonSlug: "nailiq-qa",
      serviceName: "Classic",
      whenLabel: "Tue, Sep 1, 9:00 AM",
      siteUrl: "https://nailiq.test",
    });
    const viEmail = buildCustomerAppointmentEmail({
      event: "cancel",
      locale: "vi",
      subject: "Lịch hẹn đã huỷ — NailIQ QA",
      recipientEmail: "guest@example.com",
      clientName: "Huy",
      salonName: "NailIQ QA",
      salonSlug: "nailiq-qa",
      serviceName: "Classic",
      whenLabel: "Thứ Ba, 1 tháng 9, 9:00 SA",
      siteUrl: "https://nailiq.test",
    });

    expect(en?.html).toContain("does not confirm a fee or refund");
    expect(en?.text).toContain("separate payment notice");
    expect(viEmail?.html).toContain("không xác nhận phí hoặc hoàn tiền");
    expect(viEmail?.html).toContain("Quản lý email không bắt buộc");
  });

  it("fails closed on unsafe site URLs and avoids a fabricated policy link without a slug", () => {
    const base = {
      event: "create" as const,
      locale: "en" as const,
      subject: "Confirmed",
      recipientEmail: "guest@example.com",
      clientName: "Guest",
      salonName: "Salon",
      serviceName: "Classic",
      whenLabel: "Tomorrow at 9:00 AM",
    };
    expect(buildCustomerAppointmentEmail({
      ...base,
      salonSlug: "salon",
      siteUrl: "http://nailiq.test",
    })).toBeNull();

    const withoutSlug = buildCustomerAppointmentEmail({
      ...base,
      siteUrl: "https://nailiq.test",
    });
    expect(withoutSlug?.html).toContain('href="https://nailiq.test/"');
    expect(withoutSlug?.html).not.toContain("/booking-terms");
  });
});
