import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runOwnerWaitlistNotificationWorker } from "@/shared/notifications/ownerWaitlistNotificationWorker";

const migrationPath =
  "supabase/migrations/20260831215857_add_durable_waitlist_owner_delivery.sql";

const lease = {
  success: true,
  code: "leased",
  outbox_id: "11111111-1111-4111-8111-111111111111",
  attempt_token: "22222222-2222-4222-8222-222222222222",
  salon_id: "33333333-3333-4333-8333-333333333333",
  waitlist_entry_id: "44444444-4444-4444-8444-444444444444",
};

function harness() {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: [lease], error: null })
    .mockResolvedValueOnce({
      data: { success: true, code: "completed" },
      error: null,
    });
  return { rpc, client: { rpc } as never };
}

describe("owner waitlist notification outbox worker", () => {
  it("uses the durable outbox id as the provider idempotency identity", async () => {
    const h = harness();
    const send = vi.fn().mockResolvedValue({
      outcome: "sent",
      reason: "provider_accepted",
      sent: 2,
      failed: 0,
    });

    await expect(
      runOwnerWaitlistNotificationWorker(10, {
        client: h.client,
        send,
      }),
    ).resolves.toMatchObject({ ok: true, claimed: 1, sent: 1 });

    expect(send).toHaveBeenCalledWith(
      lease.salon_id,
      lease.waitlist_entry_id,
      lease.outbox_id,
    );
    expect(h.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_owner_waitlist_notification_outbox",
      {
        p_outbox_id: lease.outbox_id,
        p_attempt_token: lease.attempt_token,
        p_outcome: "sent",
        p_provider_receipt_count: 2,
        p_error_code: null,
      },
    );
  });

  it("schedules a definite pre-acceptance failure and never retries inline", async () => {
    const h = harness();
    const send = vi.fn().mockResolvedValue({
      outcome: "retryable_failure",
      reason: "provider_rejected_pre_acceptance",
      sent: 0,
      failed: 1,
    });

    await expect(
      runOwnerWaitlistNotificationWorker(10, {
        client: h.client,
        send,
      }),
    ).resolves.toMatchObject({ ok: true, claimed: 1, failed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_owner_waitlist_notification_outbox",
      expect.objectContaining({ p_outcome: "failed" }),
    );
  });

  it("never dispatches a malformed lease", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ ...lease, waitlist_entry_id: "not-a-uuid" }],
      error: null,
    });
    const send = vi.fn();
    await expect(
      runOwnerWaitlistNotificationWorker(10, {
        client: { rpc } as never,
        send,
      }),
    ).resolves.toMatchObject({ ok: true, claimed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps occurrence creation atomic, leased and browser-inaccessible", () => {
    const migration = readFileSync(resolve(process.cwd(), migrationPath), "utf8");
    expect(migration).toContain(
      "AFTER INSERT ON public.booking_waitlist_entries",
    );
    expect(migration).toContain(
      "ON CONFLICT (waitlist_entry_id) DO NOTHING",
    );
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("provider_receipt_count > 0");
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.owner_waitlist_notification_outbox",
    );
    expect(migration).toContain(
      "FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)",
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,100}owner_waitlist_notification_outbox[\s\S]{0,40}service_role/i,
    );
  });
});
