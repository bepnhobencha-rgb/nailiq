import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));

import {
  completeReviewRequestSmsNotification,
  finalizeNotificationClaim,
  updateNotificationBySid,
} from "@/shared/lib/notificationLog";

describe("notification claim finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeSingle.mockResolvedValue({ data: { id: "claim-1" }, error: null });
    mocks.select.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.eq.mockReturnValue({ select: mocks.select });
    mocks.update.mockReturnValue({ eq: mocks.eq });
    mocks.from.mockReturnValue({ update: mocks.update });
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "applied" },
      error: null,
    });
  });

  it("stores suppression without a fake provider receipt or delivery time", async () => {
    await expect(finalizeNotificationClaim("claim-1", {
      status: "suppressed",
      messageSid: null,
      errorMessage: "test_salon",
    })).resolves.toBe(true);

    expect(mocks.from).toHaveBeenCalledWith("booking_notifications");
    expect(mocks.update).toHaveBeenCalledWith({
      status: "suppressed",
      twilio_message_sid: null,
      sent_at: null,
      failed_at: null,
      error_message: "test_salon",
    });
    expect(mocks.eq).toHaveBeenCalledWith("id", "claim-1");
  });

  it("stores an ambiguous provider result as unknown, not failed", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { id: "claim-2" },
      error: null,
    });
    await expect(finalizeNotificationClaim("claim-2", {
      status: "unknown",
      errorMessage: "provider_exception",
    })).resolves.toBe(true);

    expect(mocks.update).toHaveBeenCalledWith({
      status: "unknown",
      twilio_message_sid: null,
      sent_at: null,
      failed_at: null,
      error_message: "provider_exception",
    });
  });

  it("fails closed when completion updates zero rows", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await expect(finalizeNotificationClaim("claim-missing", {
      status: "sent",
      messageSid: `SM${"a".repeat(32)}`,
    })).resolves.toBe(false);
  });

  it("fails closed when the completion update is rejected", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "rls denied" },
    });

    await expect(finalizeNotificationClaim("claim-1", {
      status: "failed",
      errorMessage: "twilio_429",
    })).resolves.toBe(false);
  });

  it("fails closed when the completion request throws", async () => {
    mocks.maybeSingle.mockRejectedValueOnce(new Error("network reset"));

    await expect(finalizeNotificationClaim("claim-1", {
      status: "unknown",
      errorMessage: "provider_exception",
    })).resolves.toBe(false);
  });

  it("proves an exact Twilio SID receipt row was updated", async () => {
    const sid = `SM${"a".repeat(32)}`;

    await expect(updateNotificationBySid(sid, "delivered", null)).resolves.toEqual({
      ok: true,
      code: "applied",
    });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_twilio_message_status_receipt",
      {
        p_message_sid: sid,
        p_status: "delivered",
        p_error_code: null,
      },
    );
  });

  it("completes a review SMS claim through the SID-first RPC", async () => {
    const sid = `SM${"f".repeat(32)}`;
    mocks.rpc.mockResolvedValueOnce({
      data: { success: true, code: "completed" },
      error: null,
    });

    await expect(completeReviewRequestSmsNotification({
      notificationId: "10100000-0000-4000-8000-000000000005",
      status: "sent",
      providerMessageId: sid,
      errorCode: null,
    })).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_review_request_sms_notification",
      {
        p_notification_id: "10100000-0000-4000-8000-000000000005",
        p_status: "sent",
        p_provider_message_id: sid,
        p_error_code: null,
      },
    );
  });

  it("binds a signed review callback to its durable notification claim", async () => {
    const sid = `MM${"f".repeat(32)}`;
    const notificationId = "10100000-0000-4000-8000-000000000005";

    await expect(updateNotificationBySid(
      sid,
      "delivered",
      null,
      notificationId,
    )).resolves.toEqual({ ok: true, code: "applied" });

    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_twilio_review_request_status_receipt",
      {
        p_notification_id: notificationId,
        p_message_sid: sid,
        p_status: "delivered",
        p_error_code: null,
      },
    );
  });

  it("durably keeps an unknown Twilio SID receipt pending", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { success: true, code: "pending" },
      error: null,
    });

    await expect(updateNotificationBySid(
      `SM${"b".repeat(32)}`,
      "undelivered",
      "30003",
    )).resolves.toEqual({ ok: true, code: "pending" });
  });

  it("fails closed when a Twilio SID receipt update is rejected", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "database unavailable" },
    });

    await expect(updateNotificationBySid(
      `MM${"c".repeat(32)}`,
      "failed",
    )).resolves.toEqual({ ok: false, code: "database_error" });
  });

  it("fails closed when a Twilio SID receipt request throws", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("connection reset"));

    await expect(updateNotificationBySid(
      `SM${"d".repeat(32)}`,
      "failed",
    )).resolves.toEqual({ ok: false, code: "database_error" });
  });

  it("returns exact replay and durable conflict outcomes without a second mutation", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: { success: true, code: "exact_replay" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true, code: "durable_conflict" },
        error: null,
      });

    await expect(updateNotificationBySid(
      `SM${"e".repeat(32)}`,
      "delivered",
    )).resolves.toEqual({ ok: true, code: "exact_replay" });
    await expect(updateNotificationBySid(
      `SM${"e".repeat(32)}`,
      "failed",
      "30003",
    )).resolves.toEqual({ ok: true, code: "durable_conflict" });
  });
});
