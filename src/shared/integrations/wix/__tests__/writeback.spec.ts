import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  create: vi.fn(),
  getBooking: vi.fn(),
  findByExternalUserId: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  decline: vi.fn(),
  rows: new Map<string, Record<string, unknown> | null>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../client", () => ({
  createWixBooking: mocks.create,
  getBooking: mocks.getBooking,
  getBookingByExternalUserId: mocks.findByExternalUserId,
  confirmWixBooking: mocks.confirm,
  cancelWixBooking: mocks.cancel,
  declineWixBooking: mocks.decline,
}));
vi.mock("../looseDb", () => ({
  looseServiceClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const chain = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        upsert: () => chain,
        delete: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: mocks.rows.get(table) ?? null, error: null }),
        single: async () => ({ data: mocks.rows.get(table) ?? null, error: null }),
        then: (
          resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown,
        ) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  }),
}));

import { pushWixConfirm, pushWixCreate } from "../writeback";

const salonId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const attemptToken = "44444444-4444-4444-8444-444444444444";

function claim(code: "operation_claimed" | "reconciliation_claimed") {
  return {
    data: {
      success: true,
      code,
      operation_id: operationId,
      attempt_token: attemptToken,
      provider_external_user_id: bookingId,
    },
    error: null,
  };
}

describe("durable Wix create writeback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.clear();
    mocks.rows.set("wix_integrations", {
      site_id: "wix-site",
      wix_location_id: "wix-location",
      wix_default_resource_id: "wix-resource-default",
    });
    mocks.rows.set("bookings", {
      id: bookingId,
      service_id: "service-id",
      staff_id: "staff-id",
      start_time_utc: "2026-08-24T17:00:00.000Z",
      end_time_utc: "2026-08-24T17:30:00.000Z",
      client_name: "QA Client",
      client_phone: "+16045550101",
      client_email: "qa@nailiq.invalid",
      wix_booking_id: null,
    });
    mocks.rows.set("salons", { timezone: "America/Vancouver" });
    mocks.rows.set("services", {
      name: "QA Service",
      wix_service_id: "wix-service",
      wix_schedule_id: "wix-schedule",
    });
    mocks.rows.set("staff", { wix_resource_id: "wix-resource" });
    mocks.confirm.mockResolvedValue("CONFIRMED");
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_wix_create_writeback") return claim("operation_claimed");
      if (fn === "claim_wix_lifecycle_writeback") {
        return { data: { success: true, code: "operation_succeeded" }, error: null };
      }
      return { data: { success: true, code: "operation_completed" }, error: null };
    });
  });

  it("creates once with a stable externalUserId and atomically completes the claim", async () => {
    mocks.findByExternalUserId.mockResolvedValue(null);
    mocks.create.mockResolvedValue("wix-booking-1");

    await pushWixCreate(salonId, bookingId);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({
      booking: { externalUserId: bookingId },
      participantNotification: { notifyParticipants: false },
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_wix_create_writeback",
      expect.objectContaining({
        p_operation_id: operationId,
        p_attempt_token: attemptToken,
        p_status: "succeeded",
        p_provider_booking_id: "wix-booking-1",
      }),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("reconciles a lost create response and never POSTs the booking again", async () => {
    mocks.findByExternalUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "wix-booking-after-loss",
        externalUserId: bookingId,
        revision: "7",
        status: "CREATED",
      });
    mocks.create.mockRejectedValueOnce(new Error("socket closed after commit"));
    let claimCount = 0;
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_wix_create_writeback") {
        claimCount += 1;
        return claim(claimCount === 1 ? "operation_claimed" : "reconciliation_claimed");
      }
      if (fn === "claim_wix_lifecycle_writeback") {
        return { data: { success: true, code: "operation_succeeded" }, error: null };
      }
      return { data: { success: true, code: "operation_completed" }, error: null };
    });

    await pushWixCreate(salonId, bookingId);
    await pushWixCreate(salonId, bookingId);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.findByExternalUserId).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_wix_create_writeback",
      expect.objectContaining({
        p_status: "succeeded",
        p_provider_booking_id: "wix-booking-after-loss",
        p_provider_revision: "7",
      }),
    );
  });

  it("keeps a missing reconciliation read unknown instead of redispatching", async () => {
    mocks.findByExternalUserId.mockResolvedValue(null);
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_wix_create_writeback") return claim("reconciliation_claimed");
      return { data: { success: true, code: "operation_completed" }, error: null };
    });

    await pushWixCreate(salonId, bookingId);

    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "complete_wix_create_writeback",
      expect.objectContaining({
        p_status: "unknown",
        p_error_code: "provider_booking_not_visible",
      }),
    );
  });

  it("does no provider work while another sender owns the lease", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { success: true, code: "operation_in_flight", operation_id: operationId },
      error: null,
    });

    await pushWixCreate(salonId, bookingId);

    expect(mocks.findByExternalUserId).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("durably completes a lifecycle target after provider readback", async () => {
    mocks.rows.set("bookings", {
      ...mocks.rows.get("bookings"),
      wix_booking_id: "wix-booking-lifecycle",
    });
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_wix_lifecycle_writeback") {
        return {
          data: {
            success: true,
            code: "operation_claimed",
            operation_id: operationId,
            attempt_token: attemptToken,
            action: "confirm",
            target_status: "CONFIRMED",
            provider_booking_id: "wix-booking-lifecycle",
          },
          error: null,
        };
      }
      return { data: { success: true, code: "operation_completed" }, error: null };
    });
    mocks.getBooking
      .mockResolvedValueOnce({ id: "wix-booking-lifecycle", revision: "1", status: "PENDING" })
      .mockResolvedValueOnce({ id: "wix-booking-lifecycle", revision: "2", status: "CONFIRMED" });

    await pushWixConfirm(salonId, bookingId);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_wix_lifecycle_writeback",
      expect.objectContaining({
        p_status: "succeeded",
        p_provider_revision: "2",
      }),
    );
  });

  it("reconciles lifecycle response loss by reading target state without a second mutation", async () => {
    mocks.rows.set("bookings", {
      ...mocks.rows.get("bookings"),
      wix_booking_id: "wix-booking-lifecycle-loss",
    });
    let claimCount = 0;
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_wix_lifecycle_writeback") {
        claimCount += 1;
        return {
          data: {
            success: true,
            code: claimCount === 1 ? "operation_claimed" : "reconciliation_claimed",
            operation_id: operationId,
            attempt_token: attemptToken,
            action: "confirm",
            target_status: "CONFIRMED",
            provider_booking_id: "wix-booking-lifecycle-loss",
          },
          error: null,
        };
      }
      return { data: { success: true, code: "operation_completed" }, error: null };
    });
    mocks.getBooking
      .mockResolvedValueOnce({ id: "wix-booking-lifecycle-loss", revision: "1", status: "PENDING" })
      .mockResolvedValueOnce({ id: "wix-booking-lifecycle-loss", revision: "2", status: "CONFIRMED" });
    mocks.confirm.mockRejectedValueOnce(new Error("socket closed after commit"));

    await pushWixConfirm(salonId, bookingId);
    await pushWixConfirm(salonId, bookingId);

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_wix_lifecycle_writeback",
      expect.objectContaining({ p_status: "unknown" }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_wix_lifecycle_writeback",
      expect.objectContaining({ p_status: "succeeded", p_provider_revision: "2" }),
    );
  });
});
