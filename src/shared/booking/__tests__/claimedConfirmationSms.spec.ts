import { beforeEach, describe, expect, it, vi } from "vitest";

const tokenizedDelivery = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/shared/booking/bookingConfirmationRetryDelivery", () => ({
  deliverBookingConfirmation: tokenizedDelivery,
}));

import {
  classifyDurableConfirmationStatus,
  isTwilioMessageReceipt,
  sendClaimedBookingConfirmationSms,
  type ClaimedConfirmationSmsDeps,
} from "@/shared/booking/claimedConfirmationSms";

const params = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  salonId: "22222222-2222-4222-8222-222222222222",
  clientPhone: "+16045101234",
  message: "Booked from persisted facts",
  statusCallbackUrl: "https://example.test/api/twilio/status",
  salonIsTest: false,
  lang: "en" as const,
};

function makeDeps() {
  const claim = vi.fn();
  const send = vi.fn();
  const finalize = vi.fn();
  return {
    claim,
    send,
    finalize,
    deps: { claim, send, finalize } as unknown as ClaimedConfirmationSmsDeps,
  };
}

describe("claimed booking confirmation SMS boundary", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    tokenizedDelivery.mockReset();
  });

  it("uses the tokenized immutable-envelope delivery contract by default", async () => {
    const sid = `SM${"a".repeat(32)}`;
    tokenizedDelivery.mockResolvedValue({
      outcome: "accepted",
      reason: "provider_accepted",
      claimId: "claim-1",
      providerMessageId: sid,
      finalized: true,
    });

    await expect(sendClaimedBookingConfirmationSms(params)).resolves.toEqual({
      outcome: "accepted",
      reason: "provider_accepted",
      claimId: "claim-1",
      messageSid: sid,
      claimFinalized: true,
    });
    expect(tokenizedDelivery).toHaveBeenCalledWith({
      bookingId: params.bookingId,
      salonId: params.salonId,
      envelope: {
        v: 1,
        channel: "sms",
        salonId: params.salonId,
        to: params.clientPhone,
        body: params.message,
        statusCallbackUrl: params.statusCallbackUrl,
        salonIsTest: params.salonIsTest,
        lang: params.lang,
      },
      suppressionReason: undefined,
    });
  });

  it("accepts durable duplicates only for exact sent receipts or true suppression", () => {
    const sid = `MM${"e".repeat(32)}`;
    expect(classifyDurableConfirmationStatus("sent", sid)).toEqual({
      complete: true,
      outcome: "accepted",
      reason: "durable_sent",
      messageSid: sid,
    });
    expect(classifyDurableConfirmationStatus("delivered", sid)).toEqual({
      complete: true,
      outcome: "accepted",
      reason: "durable_delivered",
      messageSid: sid,
    });
    expect(classifyDurableConfirmationStatus("suppressed", null)).toEqual({
      complete: true,
      outcome: "suppressed",
      reason: "durable_suppressed",
      messageSid: null,
    });
  });

  it.each([
    ["sending", null, "durable_sending"],
    ["unknown", null, "durable_unknown"],
    ["failed", null, "durable_failed"],
    ["undelivered", null, "durable_undelivered"],
    ["sent", "SM_bad", "durable_sent_receipt_invalid"],
    ["delivered", "MM_bad", "durable_delivered_receipt_invalid"],
    ["suppressed", `SM${"f".repeat(32)}`, "durable_suppressed_receipt_present"],
    [null, null, "durable_status_unreadable"],
  ])("keeps non-terminal/inconsistent durable state fail-closed: %s", (status, sid, reason) => {
    expect(classifyDurableConfirmationStatus(status, sid)).toEqual({
      complete: false,
      outcome: "unknown",
      reason,
      messageSid: null,
    });
  });

  it("fails closed when the durable claim is unavailable", async () => {
    const mocks = makeDeps();
    mocks.claim.mockResolvedValue("unguarded");

    await expect(
      sendClaimedBookingConfirmationSms(params, mocks.deps),
    ).resolves.toEqual({
      outcome: "unknown",
      reason: "claim_unavailable",
      claimId: null,
      messageSid: null,
      claimFinalized: false,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("fails closed when acquiring the durable claim throws", async () => {
    const mocks = makeDeps();
    mocks.claim.mockRejectedValue(new Error("database unavailable"));

    await expect(
      sendClaimedBookingConfirmationSms(params, mocks.deps),
    ).resolves.toMatchObject({
      outcome: "unknown",
      reason: "claim_unavailable",
      claimFinalized: false,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("lets one concurrent caller send and suppresses every replay", async () => {
    const mocks = makeDeps();
    const sid = `SM${"a".repeat(32)}`;
    mocks.claim
      .mockResolvedValueOnce("claim-1")
      .mockResolvedValueOnce("skip")
      .mockResolvedValueOnce("skip");
    mocks.send.mockResolvedValue({ ok: true, messageSid: sid });
    mocks.finalize.mockResolvedValue(true);

    const [winner, replayOne, replayTwo] = await Promise.all([
      sendClaimedBookingConfirmationSms(params, mocks.deps),
      sendClaimedBookingConfirmationSms(params, mocks.deps),
      sendClaimedBookingConfirmationSms(params, mocks.deps),
    ]);

    expect(winner.outcome).toBe("accepted");
    expect(replayOne).toMatchObject({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
    });
    expect(replayTwo).toMatchObject({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledTimes(1);
  });

  it.each([`SM${"0".repeat(32)}`, `MM${"f".repeat(32)}`])(
    "accepts only a real-format Twilio receipt: %s",
    async (sid) => {
      const mocks = makeDeps();
      mocks.claim.mockResolvedValue("claim-1");
      mocks.send.mockResolvedValue({ ok: true, messageSid: sid });
      mocks.finalize.mockResolvedValue(true);

      const result = await sendClaimedBookingConfirmationSms(params, mocks.deps);

      expect(result).toMatchObject({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-1",
        messageSid: sid,
      });
      expect(mocks.finalize).toHaveBeenCalledWith("claim-1", {
        status: "sent",
        messageSid: sid,
        errorMessage: null,
      });
    },
  );

  it("does not treat ok=true with a malformed receipt as accepted", async () => {
    const mocks = makeDeps();
    mocks.claim.mockResolvedValue("claim-1");
    mocks.send.mockResolvedValue({ ok: true, messageSid: "SM_not_a_receipt" });
    mocks.finalize.mockResolvedValue(true);

    const result = await sendClaimedBookingConfirmationSms(params, mocks.deps);

    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "invalid_provider_receipt",
      messageSid: null,
    });
    expect(mocks.finalize).toHaveBeenCalledWith("claim-1", {
      status: "unknown",
      messageSid: null,
      errorMessage: "invalid_provider_receipt",
    });
  });

  it("stores a kill-switch suppression without a provider receipt", async () => {
    const mocks = makeDeps();
    mocks.claim.mockResolvedValue("claim-1");
    mocks.send.mockResolvedValue({
      ok: true,
      suppressed: true,
      suppressionReason: "test_salon",
      messageSid: "SUPPRESSED_test_salon_local-marker",
    });
    mocks.finalize.mockResolvedValue(true);

    const result = await sendClaimedBookingConfirmationSms(params, mocks.deps);

    expect(result).toMatchObject({
      outcome: "suppressed",
      reason: "test_salon",
      claimId: "claim-1",
      messageSid: null,
    });
    expect(mocks.finalize).toHaveBeenCalledWith("claim-1", {
      status: "suppressed",
      messageSid: null,
      errorMessage: "test_salon",
    });
  });

  it("durably stores a server-side outbound suppression without a provider call", async () => {
    const mocks = makeDeps();
    mocks.claim.mockResolvedValue("claim-1");
    mocks.finalize.mockResolvedValue(true);

    const result = await sendClaimedBookingConfirmationSms(
      { ...params, suppressionReason: "outbound_disabled" },
      mocks.deps,
    );

    expect(result).toEqual({
      outcome: "suppressed",
      reason: "outbound_disabled",
      claimId: "claim-1",
      messageSid: null,
      claimFinalized: true,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith("claim-1", {
      status: "suppressed",
      messageSid: null,
      errorMessage: "outbound_disabled",
    });
  });

  it("records a definitive Twilio HTTP rejection as failed", async () => {
    const mocks = makeDeps();
    mocks.claim.mockResolvedValue("claim-1");
    mocks.send.mockResolvedValue({ ok: false, error: "twilio_429" });
    mocks.finalize.mockResolvedValue(true);

    const result = await sendClaimedBookingConfirmationSms(params, mocks.deps);

    expect(result.outcome).toBe("rejected");
    expect(mocks.finalize).toHaveBeenCalledWith("claim-1", {
      status: "failed",
      messageSid: null,
      errorMessage: "twilio_429",
    });
  });

  it("records a thrown provider call as unknown and preserves the claim", async () => {
    const mocks = makeDeps();
    mocks.claim.mockResolvedValue("claim-1");
    mocks.send.mockRejectedValue(new Error("connection reset"));
    mocks.finalize.mockResolvedValue(true);

    const result = await sendClaimedBookingConfirmationSms(params, mocks.deps);

    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "provider_exception",
      claimId: "claim-1",
      messageSid: null,
    });
    expect(mocks.finalize).toHaveBeenCalledWith("claim-1", {
      status: "unknown",
      messageSid: null,
      errorMessage: "provider_exception",
    });
  });

  it("surfaces a lost completion after the provider accepted the send", async () => {
    const mocks = makeDeps();
    const sid = `SM${"c".repeat(32)}`;
    mocks.claim.mockResolvedValue("claim-1");
    mocks.send.mockResolvedValue({ ok: true, messageSid: sid });
    mocks.finalize.mockResolvedValue(false);

    await expect(
      sendClaimedBookingConfirmationSms(params, mocks.deps),
    ).resolves.toMatchObject({
      outcome: "accepted",
      reason: "provider_accepted",
      messageSid: sid,
      claimFinalized: false,
    });
  });

  it("surfaces a thrown completion after the provider accepted the send", async () => {
    const mocks = makeDeps();
    const sid = `SM${"d".repeat(32)}`;
    mocks.claim.mockResolvedValue("claim-1");
    mocks.send.mockResolvedValue({ ok: true, messageSid: sid });
    mocks.finalize.mockRejectedValue(new Error("database unavailable"));

    await expect(
      sendClaimedBookingConfirmationSms(params, mocks.deps),
    ).resolves.toMatchObject({
      outcome: "accepted",
      messageSid: sid,
      claimFinalized: false,
    });
  });

  it("validates Twilio receipt shape exactly", () => {
    expect(isTwilioMessageReceipt(`SM${"a".repeat(32)}`)).toBe(true);
    expect(isTwilioMessageReceipt(`MM${"A".repeat(32)}`)).toBe(true);
    expect(isTwilioMessageReceipt(`SM${"a".repeat(31)}`)).toBe(false);
    expect(isTwilioMessageReceipt(`SM${"g".repeat(32)}`)).toBe(false);
    expect(isTwilioMessageReceipt(`CA${"a".repeat(32)}`)).toBe(false);
    expect(isTwilioMessageReceipt("SUPPRESSED_test_salon_marker")).toBe(false);
  });
});
