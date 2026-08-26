import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import {
  claimReminderDelivery,
  classifyReminderProviderResult,
  completeReminderDelivery,
} from "@/shared/reminders/reminderDeliveryClaims";

describe("reminderDeliveryClaims", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims the exact booking occurrence and channel", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        success: true,
        claimed: true,
        claim_id: "11111111-1111-4111-8111-111111111111",
      },
      error: null,
    });
    await expect(
      claimReminderDelivery({
        salonId: "salon",
        bookingId: "booking",
        appointmentStartUtc: "2026-08-24T18:00:00.000Z",
        reminderType: "24h",
        channel: "sms",
      }),
    ).resolves.toEqual({
      ok: true,
      claimed: true,
      claimId: "11111111-1111-4111-8111-111111111111",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_booking_reminder_delivery",
      expect.objectContaining({ p_channel: "sms", p_reminder_type: "24h" }),
    );
  });

  it("fails closed when the database claim is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    await expect(
      claimReminderDelivery({
        salonId: "salon",
        bookingId: "booking",
        appointmentStartUtc: "2026-08-24T18:00:00.000Z",
        reminderType: "3h",
        channel: "email",
      }),
    ).resolves.toEqual({ ok: false, error: "claim_unavailable" });
  });

  it("classifies accepted, suppressed, known rejection and ambiguity", () => {
    expect(
      classifyReminderProviderResult(
        { ok: true, messageSid: `SM${"1".repeat(32)}` },
        "sms",
      ),
    ).toEqual({
      status: "sent",
      providerMessageId: `SM${"1".repeat(32)}`,
      errorCode: null,
    });
    expect(
      classifyReminderProviderResult({
        ok: true,
        suppressed: true,
        suppressionReason: "email_opt_out",
      }, "email"),
    ).toMatchObject({
      status: "suppressed",
      providerMessageId: null,
      errorCode: "delivery_suppressed:email_opt_out",
    });
    expect(classifyReminderProviderResult({ ok: true }, "sms")).toMatchObject({
      status: "unknown",
      errorCode: "provider_receipt_missing",
    });
    expect(
      classifyReminderProviderResult({ ok: false, error: "twilio_400" }, "sms"),
    ).toMatchObject({ status: "failed" });
    expect(
      classifyReminderProviderResult({ ok: false, error: "fetch failed" }, "sms"),
    ).toMatchObject({ status: "unknown" });
  });

  it("never records malformed SMS or email provider receipts as sent", () => {
    expect(
      classifyReminderProviderResult({ ok: true, messageSid: "SM123" }, "sms"),
    ).toMatchObject({
      status: "unknown",
      providerMessageId: null,
      errorCode: "invalid_provider_receipt",
    });
    expect(
      classifyReminderProviderResult(
        { ok: true, messageId: `email-${"x".repeat(200)}` },
        "email",
      ),
    ).toMatchObject({ status: "unknown", errorCode: "invalid_provider_receipt" });
  });

  it("completes only through the database RPC", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "completed" },
      error: null,
    });
    await expect(
      completeReminderDelivery({
        claimId: "11111111-1111-4111-8111-111111111111",
        status: "unknown",
        errorCode: "provider_outcome_unknown",
      }),
    ).resolves.toBe(true);
  });
});
