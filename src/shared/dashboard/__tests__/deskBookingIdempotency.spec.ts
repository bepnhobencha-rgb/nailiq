import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { committedBookingLifecycleError } from "@/shared/booking/committedBookingLifecycle";
import {
  deskBookingIntentKey,
  deskBookingRequestForIntent,
  isDeskBookingRequestId,
  isSameDeskBookingRequest,
  type ExistingDeskBookingRequest,
} from "@/shared/dashboard/deskBookingIdempotency";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const SALON_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE_ID = "44444444-4444-4444-8444-444444444444";
const STAFF_A = "55555555-5555-4555-8555-555555555555";
const ADDON_ID = "66666666-6666-4666-8666-666666666666";

const baseIntent = {
  salonId: SALON_ID,
  serviceId: SERVICE_ID,
  addonServiceIds: [ADDON_ID],
  staffId: BOOKING_ANY_STAFF_ID,
  bookingDateYmd: "2026-08-21",
  timeSlot: "10:00 AM",
  clientName: "Mai Nguyen",
  clientPhone: "16045550123",
  clientEmail: "mai@example.com",
  clientNotes: "Window seat",
};

const committed: ExistingDeskBookingRequest = {
  id: "77777777-7777-4777-8777-777777777777",
  salonId: SALON_ID,
  serviceId: SERVICE_ID,
  staffId: STAFF_A,
  clientName: "Mai Nguyen",
  clientPhone: "16045550123",
  clientEmail: "mai@example.com",
  clientNotes: "Window seat",
  startTimeUtc: "2026-08-21T17:00:00.000Z",
  resourceId: null,
  addonServiceIds: [ADDON_ID],
};

describe("desk booking response-loss idempotency", () => {
  it("keeps one request UUID across retry and rotates it for a changed intent", () => {
    const originalKey = deskBookingIntentKey(baseIntent);
    const first = deskBookingRequestForIntent(null, originalKey, () => REQUEST_ID);
    const retry = deskBookingRequestForIntent(first, originalKey, () => NEXT_REQUEST_ID);
    const changed = deskBookingRequestForIntent(
      retry,
      deskBookingIntentKey({ ...baseIntent, timeSlot: "10:15 AM" }),
      () => NEXT_REQUEST_ID,
    );

    expect(retry).toBe(first);
    expect(retry.requestId).toBe(REQUEST_ID);
    expect(changed.requestId).toBe(NEXT_REQUEST_ID);
  });

  it("returns the committed Any-staff booking after a lost response with one create", () => {
    const intentKey = deskBookingIntentKey(baseIntent);
    let requestState = deskBookingRequestForIntent(null, intentKey, () => REQUEST_ID);
    const rows = new Map<string, ExistingDeskBookingRequest>();
    let createCount = 0;

    const attempt = (): string => {
      const existing = rows.get(requestState.requestId);
      if (existing) {
        expect(
          isSameDeskBookingRequest(existing, {
            salonId: SALON_ID,
            serviceId: SERVICE_ID,
            requestedStaffId: BOOKING_ANY_STAFF_ID,
            clientName: "Mai Nguyen",
            clientPhone: "16045550123",
            clientEmail: "mai@example.com",
            clientNotes: "Window seat",
            startTimeUtc: "2026-08-21T17:00:00.000Z",
            requestedResourceId: null,
            addonServiceIds: [ADDON_ID],
          }),
        ).toBe(true);
        return existing.id;
      }
      createCount += 1;
      rows.set(requestState.requestId, committed);
      return committed.id;
    };

    const committedId = attempt();
    // The action committed, but its HTTP response was lost. The unchanged
    // caller intent retains its UUID and finds the row before staff selection.
    requestState = deskBookingRequestForIntent(requestState, intentKey, () => NEXT_REQUEST_ID);
    const replayedId = attempt();

    expect(replayedId).toBe(committedId);
    expect(rows.size).toBe(1);
    expect(createCount).toBe(1);
  });

  it("fails closed for missing/invalid IDs and mismatched replay facts", () => {
    expect(isDeskBookingRequestId(undefined)).toBe(false);
    expect(isDeskBookingRequestId("")).toBe(false);
    expect(isDeskBookingRequestId("not-a-uuid")).toBe(false);
    expect(isDeskBookingRequestId(REQUEST_ID)).toBe(true);

    expect(
      isSameDeskBookingRequest(committed, {
        salonId: SALON_ID,
        serviceId: SERVICE_ID,
        requestedStaffId: BOOKING_ANY_STAFF_ID,
        clientName: "Mallory",
        clientPhone: "16045550123",
        clientEmail: "mai@example.com",
        clientNotes: "Window seat",
        startTimeUtc: "2026-08-21T17:00:00.000Z",
        requestedResourceId: null,
        addonServiceIds: [ADDON_ID],
      }),
    ).toBe(false);
  });

  it("does not reconcile a desk replay after cancellation, completion, or reschedule", () => {
    expect(
      committedBookingLifecycleError({
        status: "cancelled",
        persistedStartTimeUtc: committed.startTimeUtc,
        requestedStartTimeUtc: committed.startTimeUtc,
      }),
    ).toBe("booking_cancelled");
    expect(
      committedBookingLifecycleError({
        status: "completed",
        persistedStartTimeUtc: committed.startTimeUtc,
        requestedStartTimeUtc: committed.startTimeUtc,
      }),
    ).toBe("booking_completed");
    expect(
      committedBookingLifecycleError({
        status: "confirmed",
        persistedStartTimeUtc: "2026-08-21T18:00:00.000Z",
        requestedStartTimeUtc: committed.startTimeUtc,
      }),
    ).toBe("booking_rescheduled");
  });

  it("wires both callers and the canonical create boundary to the same requestId", () => {
    const action = readFileSync(
      resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
      "utf8",
    );
    const form = readFileSync(
      resolve(process.cwd(), "src/components/receptionist/DeskBookingForm.tsx"),
      "utf8",
    );
    const copilot = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/AdminCopilot.tsx"),
      "utf8",
    );

    expect(action).toContain(
      'if (!isDeskBookingRequestId(requestId)) return fail("invalid_request_id")',
    );
    expect(action).toContain(".eq(\"idempotency_key\", requestId)");
    expect(action.indexOf('.eq("idempotency_key", requestId)')).toBeLessThan(
      action.indexOf('"public_booking_occupancy_for_range"'),
    );
    expect(action).toContain("isSameDeskBookingRequest(");
    expect(action).toContain('"id, status, salon_id, service_id');
    const lifecycleGuard = action.indexOf(
      "const lifecycleError = committedBookingLifecycleError({",
      action.indexOf("isSameDeskBookingRequest("),
    );
    const replaySchedule = action.indexOf(
      "scheduleDeskBookingReconciliation({",
      action.indexOf("isSameDeskBookingRequest("),
    );
    const replayReturn = action.indexOf(
      "return { ok: true, bookingId: existing.id }",
      action.indexOf("isSameDeskBookingRequest("),
    );
    expect(replaySchedule).toBeGreaterThan(-1);
    expect(lifecycleGuard).toBeGreaterThan(-1);
    expect(lifecycleGuard).toBeLessThan(replaySchedule);
    expect(replaySchedule).toBeLessThan(replayReturn);
    expect(action).toContain("reconcileCommittedBooking({");
    expect(action.match(/scheduleDeskBookingReconciliation\(\{/g)).toHaveLength(2);
    expect(action).toContain("p_idempotency_key: requestId");
    expect(action).not.toContain("p_idempotency_key: crypto.randomUUID()");
    expect(form).toContain("requestId: requestState.requestId");
    expect(copilot).toContain("requestId: requestState.requestId");
    expect(form).toContain("deskBookingRequestForIntent(");
    expect(copilot).toContain("deskBookingRequestForIntent(");
    expect(form).toContain("keep submissionRequestRef intact");
    expect(form.indexOf("submissionRequestRef.current = null")).toBeGreaterThan(
      form.indexOf("if (res.ok)"),
    );
  });
});
