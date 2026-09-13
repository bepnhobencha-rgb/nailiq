import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBoundedPublicBookingRpc } from "../publicBookingRpcBoundary";

const requestId = "11111111-1111-4111-8111-111111111111";

describe("MQA-0155 Supabase latency acceptance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a delayed commit as unknown and aborts the transport", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const invoke = vi.fn((_requestId: string, nextSignal: AbortSignal) => {
      signals.push(nextSignal);
      return new Promise<never>(() => undefined);
    });

    const pending = runBoundedPublicBookingRpc({
      requestId,
      invoke,
      timeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual({
      kind: "outcome_unknown",
      requestId,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(requestId, expect.any(AbortSignal));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("retries only the same logical request and recovers the committed receipt", async () => {
    vi.useFakeTimers();
    const seenRequestIds: string[] = [];
    let attempt = 0;
    const invoke = vi.fn((nextRequestId: string) => {
      seenRequestIds.push(nextRequestId);
      attempt += 1;
      if (attempt === 1) return new Promise<never>(() => undefined);
      return Promise.resolve({
        success: true,
        code: "booking_replay",
        booking_id: "22222222-2222-4222-8222-222222222222",
        idempotent: true,
      });
    });

    const first = runBoundedPublicBookingRpc({ requestId, invoke, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toEqual({ kind: "outcome_unknown", requestId });

    await expect(runBoundedPublicBookingRpc({ requestId, invoke, timeoutMs: 100 }))
      .resolves.toEqual({
        kind: "completed",
        requestId,
        value: {
          success: true,
          code: "booking_replay",
          booking_id: "22222222-2222-4222-8222-222222222222",
          idempotent: true,
        },
      });
    expect(seenRequestIds).toEqual([requestId, requestId]);
  });

  it("does not relabel a definite immediate failure as latency", async () => {
    await expect(runBoundedPublicBookingRpc({
      requestId,
      invoke: () => Promise.reject(new Error("permission_denied")),
      timeoutMs: 100,
    })).rejects.toThrow("permission_denied");
  });

  it("wires bounded unknown outcome to receipt recovery with the canonical create key", () => {
    const submit = readFileSync("src/shared/booking/submitPublicBooking.ts", "utf8");
    const flow = readFileSync("src/components/booking/useBookingFlowState.ts", "utf8");
    const pending = readFileSync("src/shared/booking/pendingBookingCreate.ts", "utf8");

    expect(submit).toMatch(
      /p_idempotency_key:\s*createIdempotencyKey[\s\S]*dispatchPendingBookingCreate\([\s\S]*idempotencyKey:\s*createIdempotencyKey[\s\S]*create_public_booking[\s\S]*abortSignal\(signal\)/,
    );
    expect(pending).toMatch(/runBoundedPublicBookingRpc[\s\S]*requestId: args.binding.idempotencyKey[\s\S]*BookingCreateOutcomeUnknownError/);
    expect(flow).toMatch(
      /BookingCreateOutcomeUnknownError[\s\S]*recoveryRouter.replace\(err.recoveryHref\)/,
    );
    expect(flow).toContain("bookingSubmitIdempotencyKeyRef.current");
  });
});
