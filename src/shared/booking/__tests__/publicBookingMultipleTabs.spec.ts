import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  acknowledgePublicBookingRequestId,
  stablePublicBookingRequestId,
  type PublicBookingRequestMaterial,
} from "@/shared/booking/publicBookingRequestId";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class SerialLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(name, previous.then(() => current));
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_ID = "22222222-2222-4222-8222-222222222222";
const material: PublicBookingRequestMaterial = {
  salonId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  clientName: "Guest One",
  clientPhone: "16045551234",
  startTimeUtc: "2026-08-21T17:00:00.000Z",
  endTimeUtc: "2026-08-21T18:00:00.000Z",
  clientNotes: "quiet table",
  addonServiceIds: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
  clientEmail: "guest@example.test",
  resourceId: null,
  comboId: null,
  voucherId: null,
  applyEmailDiscount: true,
  expectedPricingFingerprint: "a".repeat(64),
};

describe("MQA-0039 public booking across browser tabs", () => {
  it("serializes independent tabs so one exact intent gets one durable replay", async () => {
    const storage = new MemoryStorage();
    const locks = new SerialLockManager();
    let minted = 0;
    const options = {
      storage,
      locks,
      now: 1_000,
      newId: () => (++minted === 1 ? FIRST_ID : NEXT_ID),
    };

    const [firstTabId, secondTabId] = await Promise.all([
      stablePublicBookingRequestId(material, options),
      stablePublicBookingRequestId(material, options),
    ]);
    expect(firstTabId).toBe(FIRST_ID);
    expect(secondTabId).toBe(FIRST_ID);
    expect(minted).toBe(1);

    const durable = new Map<string, string>();
    const submit = async (requestId: string) => {
      const existing = durable.get(requestId);
      if (existing) return { bookingId: existing, idempotent: true };
      const bookingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      durable.set(requestId, bookingId);
      return { bookingId, idempotent: false };
    };
    const results = await Promise.all([submit(firstTabId), submit(secondTabId)]);
    expect(durable.size).toBe(1);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(results[0]?.bookingId).toBe(results[1]?.bookingId);
  });

  it("keeps different intents at the same salon independent and persists no raw PII", async () => {
    const storage = new MemoryStorage();
    const locks = new SerialLockManager();
    let minted = 0;
    const options = {
      storage,
      locks,
      now: 1_000,
      newId: () => (++minted === 1 ? FIRST_ID : NEXT_ID),
    };
    const first = await stablePublicBookingRequestId(material, options);
    const second = await stablePublicBookingRequestId({
      ...material,
      clientPhone: "16045559999",
    }, options);
    expect(first).not.toBe(second);
    expect(storage.values.size).toBe(2);
    expect(JSON.stringify([...storage.values])).not.toContain(material.clientPhone);
    expect(JSON.stringify([...storage.values])).not.toContain(material.clientEmail);
    expect(JSON.stringify([...storage.values])).not.toContain(material.clientName);
  });

  it("rotates only the exact acknowledged material while an unknown outcome stays replayable", async () => {
    const storage = new MemoryStorage();
    const locks = new SerialLockManager();
    const first = await stablePublicBookingRequestId(material, {
      storage,
      locks,
      now: 1_000,
      newId: () => FIRST_ID,
    });
    expect(await stablePublicBookingRequestId(material, {
      storage,
      locks,
      now: 2_000,
      newId: () => NEXT_ID,
    })).toBe(first);

    await acknowledgePublicBookingRequestId(material, first, { storage, locks });
    expect(await stablePublicBookingRequestId(material, {
      storage,
      locks,
      now: 3_000,
      newId: () => NEXT_ID,
    })).toBe(NEXT_ID);
  });

  it("wires exact material to the canonical RPC and preserves unknown-outcome replay", () => {
    const flow = readFileSync(
      "src/components/booking/useBookingFlowState.ts",
      "utf8",
    );
    const submit = readFileSync(
      "src/shared/booking/submitPublicBooking.ts",
      "utf8",
    );
    const concurrency = readFileSync(
      "scripts/security/rehearse-public-booking-pricing-concurrency.mjs",
      "utf8",
    );

    expect(flow).toContain("stablePublicBookingRequestId(bookingRequestMaterial)");
    expect(flow).toContain("acknowledgePublicBookingRequestId(");
    expect(flow).toContain(
      "const bookingRequestIdForAttempt = bookingSubmitIdempotencyKeyRef.current",
    );
    expect(flow).toContain("idempotencyKey: bookingRequestIdForAttempt");
    const unknownBranch = flow.slice(
      flow.indexOf('err.message === "booking_commit_unknown"'),
      flow.indexOf('err.message.startsWith("card_save_failed")'),
    );
    expect(unknownBranch).not.toContain("acknowledgePublicBookingRequestId");
    expect(unknownBranch).not.toContain("crypto.randomUUID");
    expect(submit).toContain("p_idempotency_key: createIdempotencyKey");
    expect(concurrency).toContain("Promise.all([runSql(createSql), runSql(createSql)])");
    expect(concurrency).toContain("[false, true]");
    expect(concurrency).toContain("assert.equal(first.booking_id, second.booking_id)");
    expect(concurrency).toContain('assert.equal(persisted, "1|1|1")');
  });
});
