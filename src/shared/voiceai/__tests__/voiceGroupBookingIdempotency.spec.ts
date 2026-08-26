import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  parseVoiceGroupMode,
  voiceGroupBookingLogicalIdempotencyKey,
} from "@/shared/voiceai/voiceGroupBookingIdempotency";

const base = {
  sessionId: "session-1",
  salonId: "11111111-1111-4111-8111-111111111111",
  serviceAssignments: [
    { serviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", count: 1 },
    { serviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", count: 2 },
  ],
  date: "2026-08-22",
  time: "10:00",
  mode: "sync_start",
  organizerName: "Mai Nguyen",
  organizerPhone: "16045550123",
};

describe("voice group logical idempotency", () => {
  it("defaults only a missing mode and rejects arbitrary mode strings", () => {
    expect(parseVoiceGroupMode(undefined)).toBe("sync_start");
    expect(parseVoiceGroupMode("sync_start")).toBe("sync_start");
    expect(parseVoiceGroupMode("sync_finish")).toBe("sync_finish");
    expect(parseVoiceGroupMode("evil")).toBeNull();
    expect(parseVoiceGroupMode(1)).toBeNull();
  });

  it("keeps one key across reordered or split equivalent service counts", () => {
    const key = voiceGroupBookingLogicalIdempotencyKey(base);
    expect(voiceGroupBookingLogicalIdempotencyKey({
      ...base,
      serviceAssignments: [
        { serviceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", count: 1 },
        { serviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", count: 1 },
        { serviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", count: 1 },
      ],
    })).toBe(key);
  });

  it("normalizes organizer display casing, spacing, and Unicode only for the key", () => {
    expect(voiceGroupBookingLogicalIdempotencyKey({
      ...base,
      organizerName: "Ma\u0301i  Nguyen",
    })).toBe(voiceGroupBookingLogicalIdempotencyKey({
      ...base,
      organizerName: "mái nguyen",
    }));
  });

  it("rotates for a material service/count/time change", () => {
    const key = voiceGroupBookingLogicalIdempotencyKey(base);
    expect(voiceGroupBookingLogicalIdempotencyKey({
      ...base,
      serviceAssignments: [{ serviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", count: 3 }],
    })).not.toBe(key);
    expect(voiceGroupBookingLogicalIdempotencyKey({ ...base, time: "10:15" })).not.toBe(key);
  });
});
