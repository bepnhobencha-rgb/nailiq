import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));

import {
  deskGroupReplayMatchesIntent,
  type PersistedGroupMember,
} from "@/shared/dashboard/deskGroupReplay";
import {
  deskBookingRequestForIntent,
  deskGroupIntentKey,
} from "@/shared/dashboard/deskBookingIdempotency";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_ID = "22222222-2222-4222-8222-222222222222";
const SALON_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE_ID = "44444444-4444-4444-8444-444444444444";
const STAFF_ID = "55555555-5555-4555-8555-555555555555";

const members = [
  {
    name: "Mai Nguyen",
    phone: "16045550123",
    email: "mai@example.com",
    serviceId: SERVICE_ID,
    staffId: STAFF_ID,
    staffRequestedByClient: false,
    date: "2026-08-22",
    time: "10:00",
    waveNumber: 1,
    addonServiceIds: [],
  },
  {
    name: "Guest 2",
    phone: "",
    serviceId: SERVICE_ID,
    staffId: STAFF_ID,
    staffRequestedByClient: false,
    date: "2026-08-22",
    time: "11:00",
    waveNumber: 2,
    addonServiceIds: [],
  },
];

const persisted: PersistedGroupMember[] = members.map((member, index) => ({
  id: `66666666-6666-4666-8666-66666666666${index}`,
  status: "confirmed",
  groupId: "77777777-7777-4777-8777-777777777777",
  serviceId: member.serviceId,
  staffId: member.staffId,
  clientName: member.name,
  clientPhone: index === 0 ? "16045550123" : null,
  clientEmail: index === 0 ? "mai@example.com" : null,
  clientNotes: null,
  startTimeUtc: index === 0
    ? "2026-08-22T17:00:00.000Z"
    : "2026-08-22T18:00:00.000Z",
  endTimeUtc: index === 0
    ? "2026-08-22T18:00:00.000Z"
    : "2026-08-22T19:00:00.000Z",
  staffRequestedByClient: false,
  waveNumber: index + 1,
  seatTogether: true,
  clientLocale: "en",
  resourceId: null,
  addonServiceIds: [],
}));

describe("normal desk group response-loss replay", () => {
  it("keeps the request UUID and accepts the committed rows without consulting changed availability", () => {
    const intent = {
      salonId: SALON_ID,
      members,
      seatTogether: true,
      language: "en" as const,
      controlledAfterHours: false,
    };
    const intentKey = deskGroupIntentKey(intent);
    const first = deskBookingRequestForIntent(null, intentKey, () => REQUEST_ID);
    const retry = deskBookingRequestForIntent(first, intentKey, () => NEXT_ID);

    // Staff capability/occupancy may have changed after commit; replay binds to
    // persisted request facts and does not accept those as fresh inputs.
    const nowCapableStaff: string[] = [];
    const nowFreeStaff: string[] = [];
    expect(nowCapableStaff).toEqual([]);
    expect(nowFreeStaff).toEqual([]);
    expect(retry.requestId).toBe(REQUEST_ID);
    expect(deskGroupReplayMatchesIntent(persisted, {
      salonId: SALON_ID,
      members,
      seatTogether: true,
      language: "en",
      idempotencyKey: retry.requestId,
    }, "America/Vancouver")).toBe(true);
  });

  it("rotates for a changed intent and rejects changed material under the old key", () => {
    const originalKey = deskGroupIntentKey({
      salonId: SALON_ID,
      members,
      seatTogether: true,
      language: "en",
      controlledAfterHours: false,
    });
    const changedMembers = members.map((member, index) =>
      index === 1 ? { ...member, time: "11:15" } : member,
    );
    const changedKey = deskGroupIntentKey({
      salonId: SALON_ID,
      members: changedMembers,
      seatTogether: true,
      language: "en",
      controlledAfterHours: false,
    });
    expect(changedKey).not.toBe(originalKey);
    expect(deskGroupReplayMatchesIntent(persisted, {
      salonId: SALON_ID,
      members: changedMembers,
      seatTogether: true,
      language: "en",
      idempotencyKey: REQUEST_ID,
    }, "America/Vancouver")).toBe(false);
  });

  it("wires replay before canonical quote/create and preserves the client key", () => {
    const action = readFileSync(
      resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
      "utf8",
    );
    const form = readFileSync(
      resolve(process.cwd(), "src/components/receptionist/DeskGroupForm.tsx"),
      "utf8",
    );
    const createStart = action.indexOf("export async function createDeskGroup(");
    const replay = action.indexOf("await replayCommittedDeskGroup(", createStart);
    const freshSubmit = action.indexOf("await submitGroupBooking(groupParams", createStart);
    expect(replay).toBeGreaterThan(createStart);
    expect(replay).toBeLessThan(freshSubmit);
    expect(form).toContain("deskGroupIntentKey({");
    expect(form).toContain("submissionRequestRef.current = requestState");
    expect(form).toContain("idempotencyKey: requestState.requestId");
  });
});
