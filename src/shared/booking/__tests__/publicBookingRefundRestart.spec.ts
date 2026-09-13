import { describe, expect, it, vi } from "vitest";
import { rotatePublicBookingRequestId, stablePublicBookingRequestId, type PublicBookingRequestMaterial } from "@/shared/booking/publicBookingRequestId";
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

describe("verified-refund explicit booking request rotation", () => {
  async function seeded() {
    const storage=new MemoryStorage();const locks=new SerialLockManager();
    await stablePublicBookingRequestId(material,{storage,locks,now:1000,newId:()=>FIRST_ID});
    return {storage,locks,now:2000,newId:vi.fn(()=>NEXT_ID)};
  }
  it("serializes two refunded tabs onto the same new identity and never overwrites an already-rotated live identity",async()=>{
    const options=await seeded();
    expect(await Promise.all([rotatePublicBookingRequestId(material,FIRST_ID,options),rotatePublicBookingRequestId(material,FIRST_ID,options)])).toEqual([NEXT_ID,NEXT_ID]);
    expect(options.newId).toHaveBeenCalledOnce();
    expect(await rotatePublicBookingRequestId(material,FIRST_ID,options)).toBe(NEXT_ID);expect(options.newId).toHaveBeenCalledOnce();
    expect(await stablePublicBookingRequestId(material,options)).toBe(NEXT_ID);
    expect([...options.storage.values.keys()].join()).not.toContain(material.clientPhone);
  });
  it("fails closed when a storage write is rejected, retaining the old receipt identity",async()=>{
    const options=await seeded();vi.spyOn(options.storage,"setItem").mockImplementation(()=>{throw new Error("blocked write");});
    await expect(rotatePublicBookingRequestId(material,FIRST_ID,options)).rejects.toThrow("blocked write");
    expect(await stablePublicBookingRequestId(material,options)).toBe(FIRST_ID);
  });
  it("detects a silently dropped write by reading back the exact new UUID and timestamp",async()=>{
    const options=await seeded();vi.spyOn(options.storage,"setItem").mockImplementation(()=>{});
    await expect(rotatePublicBookingRequestId(material,FIRST_ID,options)).rejects.toThrow("booking_restart_storage_unavailable");
    expect(await stablePublicBookingRequestId(material,options)).toBe(FIRST_ID);
  });
  it("requires readable persisted identity",async()=>{
    const options=await seeded();vi.spyOn(options.storage,"getItem").mockImplementation(()=>{throw new Error("blocked read");});
    await expect(rotatePublicBookingRequestId(material,FIRST_ID,options)).rejects.toThrow("blocked read");
    expect(options.newId).not.toHaveBeenCalled();
  });
  it("never removes the previous identity before replacing it, even when removeItem is unavailable",async()=>{
    const options=await seeded();const remove=vi.spyOn(options.storage,"removeItem").mockImplementation(()=>{throw new Error("blocked removal");});
    expect(await rotatePublicBookingRequestId(material,FIRST_ID,options)).toBe(NEXT_ID);expect(remove).not.toHaveBeenCalled();
  });
  it.each(["storage","locks"] as const)("keeps restart locked when %s is unavailable",async(missing)=>{
    const options=await seeded();
    await expect(rotatePublicBookingRequestId(material,FIRST_ID,{...options,[missing]:null})).rejects.toThrow("booking_restart_storage_unavailable");
    expect(options.newId).not.toHaveBeenCalled();
  });
  it("cannot mint the refunded ID again",async()=>{
    const options=await seeded();options.newId.mockReturnValue(FIRST_ID);
    await expect(rotatePublicBookingRequestId(material,FIRST_ID,options)).rejects.toThrow("invalid_public_booking_request_id");
  });
});
