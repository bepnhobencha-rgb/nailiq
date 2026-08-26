import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  providerSend: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({
  getResendFrom: () => "NailIQ <bookings@nailiq.ca>",
  getResendClient: () => ({ emails: { send: mocks.providerSend } }),
}));
vi.mock("@/shared/booking/bookingConfirmationRetryDelivery", () => ({
  deliverBookingConfirmation: mocks.deliver,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === "salons"
            ? {
                id: "22222222-2222-4222-8222-222222222222",
                name: "QA Salon",
                timezone: "America/Vancouver",
                currency_code: "CAD",
                reminders_enabled: false,
              }
            : table === "bookings"
              ? {
                  end_time_utc: "2026-08-21T18:00:00.000Z",
                  noshow_card_id: null,
                }
              : null,
          error: null,
        }),
      };
      return chain;
    },
  }),
}));

import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";

const input = {
  bookingId: "11111111-1111-4111-8111-111111111111",
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
  totalPriceCents: 0,
};

describe("booking confirmation email tokenized claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliver.mockResolvedValue({
      outcome: "accepted",
      reason: "provider_accepted",
      claimId: "33333333-3333-4333-8333-333333333333",
      providerMessageId: "email-1",
      finalized: true,
    });
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: "not_sequence" },
      error: null,
    });
  });

  it("hands one exact immutable Resend envelope to the tokenized delivery boundary", async () => {
    await sendBookingConfirmationEmail(input);

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const delivery = mocks.deliver.mock.calls[0]?.[0] as {
      bookingId: string;
      salonId: string;
      envelope: {
        channel: string;
        to: string;
        html: string;
        attachments: Array<{ filename: string; content: string }>;
      };
    };
    expect(delivery).toMatchObject({
      bookingId: input.bookingId,
      salonId: "22222222-2222-4222-8222-222222222222",
      envelope: { channel: "email", to: input.clientEmail },
    });
    expect(delivery.envelope.html).toContain("Voucher");
    expect(delivery.envelope.html).toContain("0.00");
    expect(delivery.envelope.html).toContain("Total");
    expect(delivery.envelope.attachments).toHaveLength(1);
    expect(delivery.envelope.attachments[0]?.filename).toBe("appointment.ics");
    expect(delivery.envelope.attachments[0]?.content).not.toContain("BEGIN:VCALENDAR");
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("routes every concurrent producer through the same durable tokenized boundary", async () => {
    await Promise.all([
      sendBookingConfirmationEmail(input),
      sendBookingConfirmationEmail(input),
    ]);
    expect(mocks.deliver).toHaveBeenCalledTimes(2);
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("does not bypass the delivery boundary when its durable claim is unavailable", async () => {
    mocks.deliver.mockResolvedValue({
      outcome: "suppressed",
      reason: "claim_unavailable",
      claimId: null,
      providerMessageId: null,
      finalized: false,
    });
    await sendBookingConfirmationEmail(input);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("rejects a malformed authoritative sequence receipt before claim or provider", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        success: true,
        code: "loaded",
        schedule_model: "segments_v1",
        sequence_version: 1,
        pricing_snapshot: { total_cents: 1 },
        segments: [],
      },
      error: null,
    });
    await sendBookingConfirmationEmail(input);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });
});
