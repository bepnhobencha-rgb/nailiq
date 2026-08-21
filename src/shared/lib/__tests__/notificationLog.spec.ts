import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));

import { finalizeNotificationClaim } from "@/shared/lib/notificationLog";

describe("notification claim finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeSingle.mockResolvedValue({ data: { id: "claim-1" }, error: null });
    mocks.select.mockReturnValue({ maybeSingle: mocks.maybeSingle });
    mocks.eq.mockReturnValue({ select: mocks.select });
    mocks.update.mockReturnValue({ eq: mocks.eq });
    mocks.from.mockReturnValue({ update: mocks.update });
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
});
