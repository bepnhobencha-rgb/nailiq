import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runOwnerBookingNotificationWorker } from "@/shared/notifications/ownerBookingNotificationWorker";

const lease = {
  success: true,
  code: "leased",
  outbox_id: "11111111-1111-4111-8111-111111111111",
  attempt_token: "22222222-2222-4222-8222-222222222222",
  salon_id: "33333333-3333-4333-8333-333333333333",
  booking_id: "44444444-4444-4444-8444-444444444444",
  event_type: "reschedule",
  occurrence_key: "a".repeat(64),
  previous_start_time_utc: "2026-08-28T18:00:00.000Z",
  group_size: 2,
  changed_by: "receptionist",
  changed_fields: ["time"],
};

function harness() {
  const rpc = vi.fn()
    .mockResolvedValueOnce({ data: [lease], error: null })
    .mockResolvedValueOnce({ data: { success: true, code: "completed" }, error: null });
  return { rpc, client: { rpc } as never };
}

describe("owner booking notification outbox worker", () => {
  it("leases immutable occurrence identity and completes only the claimed row", async () => {
    const h = harness();
    const send = vi.fn().mockResolvedValue({
      outcome: "sent",
      reason: "provider_accepted",
      sent: 1,
      failed: 0,
    });

    await expect(runOwnerBookingNotificationWorker(10, {
      client: h.client,
      send,
    })).resolves.toMatchObject({ ok: true, claimed: 1, sent: 1 });

    expect(send).toHaveBeenCalledWith({
      salonId: lease.salon_id,
      bookingId: lease.booking_id,
      event: "reschedule",
      eventOccurrenceKey: lease.occurrence_key,
      previousStartUtc: lease.previous_start_time_utc,
      groupSize: 2,
      changedBy: "receptionist",
      changedFields: ["time"],
    });
    expect(h.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_owner_booking_notification_outbox",
      {
        p_outbox_id: lease.outbox_id,
        p_attempt_token: lease.attempt_token,
        p_outcome: "sent",
        p_error_code: null,
      },
    );
  });

  it("schedules definite pre-acceptance provider failures without retrying inline", async () => {
    const h = harness();
    const send = vi.fn().mockResolvedValue({
      outcome: "retryable_failure",
      reason: "provider_rejected_pre_acceptance",
      sent: 0,
      failed: 1,
    });

    const result = await runOwnerBookingNotificationWorker(10, {
      client: h.client,
      send,
    });
    expect(result).toMatchObject({ ok: true, claimed: 1, failed: 1 });
    expect(h.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_owner_booking_notification_outbox",
      expect.objectContaining({ p_outcome: "failed" }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never dispatches malformed leases", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ ...lease, occurrence_key: "not-a-fingerprint" }],
      error: null,
    });
    const send = vi.fn();
    const result = await runOwnerBookingNotificationWorker(10, {
      client: { rpc } as never,
      send,
    });
    expect(result).toMatchObject({ ok: true, claimed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("keeps occurrence creation atomic, group-deduped, leased, and browser-inaccessible", () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260828011125_add_owner_booking_notification_outbox.sql",
    ), "utf8");
    expect(migration).toContain("AFTER INSERT OR UPDATE OF start_time_utc ON public.bookings");
    expect(migration).toContain("NEW.is_group_organizer IS NOT TRUE");
    expect(migration).toContain("NEW.wix_booking_id IS NOT NULL OR NEW.square_booking_id IS NOT NULL");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("provider_receipt_count > 0");
    expect(migration).toContain("REVOKE ALL PRIVILEGES ON TABLE public.owner_booking_notification_outbox");
    expect(migration).not.toMatch(
      /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,80}ON\s+TABLE\s+public\.owner_booking_notification_outbox\s+TO\s+service_role/i,
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.resolve_owner_booking_notification_occurrence(uuid, uuid, text)",
    );
    expect(migration).toContain("FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)");
    expect(migration).not.toMatch(/INSERT INTO public\.owner_booking_notification_outbox[\s\S]{0,200}SELECT/i);
  });
});
