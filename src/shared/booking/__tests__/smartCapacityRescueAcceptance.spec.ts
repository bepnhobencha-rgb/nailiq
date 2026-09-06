import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260831193000_add_smart_capacity_rescue_requests.sql",
  ),
  "utf8",
);
const groupFlow = readFileSync(
  resolve(root, "src/components/booking/BookingGroupFlow.tsx"),
  "utf8",
);
const sequenceFlow = readFileSync(
  resolve(root, "src/components/booking/BookingSequenceFlow.tsx"),
  "utf8",
);
const receptionistLoader = readFileSync(
  resolve(root, "src/shared/dashboard/loadReceptionistCenterData.ts"),
  "utf8",
);
const receptionistPanel = readFileSync(
  resolve(root, "src/components/receptionist/OnlineWaitlistPanel.tsx"),
  "utf8",
);
const bookingVi = readFileSync(
  resolve(root, "src/shared/i18n/booking/vi.ts"),
  "utf8",
);
const bookingEn = readFileSync(
  resolve(root, "src/shared/i18n/booking/en.ts"),
  "utf8",
);

describe("Smart Capacity Rescue acceptance boundary", () => {
  it("keeps public creation tenant-scoped, idempotent, and explicit about grants", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain("booking_waitlist_request_id_unique");
    expect(migration).toContain("booking_waitlist_active_intent_unique");
    expect(migration).toContain("request_id_conflict");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).toContain(
      ") FROM PUBLIC, anon, authenticated, service_role;",
    );
    expect(migration).toContain(") TO anon, service_role;");
    expect(migration).not.toContain(") TO anon, authenticated, service_role;");
    expect(migration).toContain("service.salon_id = p_salon_id");
    expect(migration).toContain("person.salon_id = p_salon_id");
  });

  it("never feeds a group or multi-service request to the single-slot worker", () => {
    expect(migration).toContain(
      "CASE WHEN v_kind = 'individual' THEN 'waiting' ELSE 'review_required' END",
    );
    expect(migration).toContain("'review_required'::text");
    expect(receptionistLoader).toContain(
      '.in("status", ["waiting", "review_required", "notified"])',
    );
    expect(receptionistPanel).toContain('entry.status === "review_required"');
    expect(receptionistPanel).toContain("waitlist-arrange-");
  });

  it("offers rescue only after complex scheduling cannot produce a valid plan", () => {
    expect(groupFlow).toContain('scheduleResult.reason === "no_slots"');
    expect(groupFlow).toContain('requestKind: "group"');
    expect(sequenceFlow).toContain('requestKind: "sequence"');
    expect(sequenceFlow).toContain("capacityRescueEligible");
    expect(sequenceFlow).toContain(
      'result.code === "no_shared_parallel_resource"',
    );
  });

  it("describes wave groups truthfully before the customer chooses an arrangement", () => {
    expect(groupFlow).toContain("earlier.arrangement.isWaveBooking");
    expect(groupFlow).toContain("groupEarlierTodayWaves");
    expect(bookingVi).toContain("nhóm lớn có thể được chia thành nhiều đợt");
    expect(bookingEn).toContain("larger groups may be split into multiple waves");
    expect(bookingVi).not.toContain("Chúng tôi sẽ chuẩn bị 2 giường cạnh nhau");
  });

  it("rejects unknown or sensitive intent keys at the database boundary", () => {
    expect(migration).toContain("invalid_intent_keys");
    expect(migration).toMatch(
      /card\|otp\|health\|note\|price\|provider\|token\|secret/,
    );
    expect(migration).toContain("invalid_group_intent");
    expect(migration).toContain("invalid_sequence_intent");
    expect(migration).toContain("primary_service_missing");
  });
});
