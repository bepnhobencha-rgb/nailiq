import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { buildHtml } from "@/shared/booking/sendBookingConfirmationEmail";

describe("booking confirmation authoritative receipt", () => {
  it("renders discounts and an explicit zero total for a fully discounted booking", () => {
    const html = buildHtml(
      "QA Salon",
      {
        bookingId: "booking-1",
        shopSlug: "qa-salon",
        clientName: "Mai",
        clientEmail: "mai@example.com",
        serviceName: "Manicure",
        staffName: "Anna",
        startTimeUtc: "2026-08-21T17:00:00.000Z",
        currencyCode: "CAD",
        servicePriceCents: 5_000,
        discountLines: [{ label: "Voucher", amountCents: 5_000 }],
        subtotalCents: 0,
        taxBreakdown: [],
        totalPriceCents: 0,
      },
      "Friday, August 21, 10:00 AM",
      "https://nailiq.ca/booking/status?token=11111111-1111-4111-8111-111111111111",
      "CAD",
      null,
    );
    expect(html).toContain("Voucher");
    expect(html).toContain("50.00");
    expect(html).toContain("0.00");
    expect(html).toContain("Total");
  });
});
