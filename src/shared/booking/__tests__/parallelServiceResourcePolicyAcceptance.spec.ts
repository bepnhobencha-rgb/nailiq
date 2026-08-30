import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260830100409_add_parallel_multi_service_resource_policy.sql"),
  "utf8",
);
const actions = readFileSync(
  resolve(root, "src/shared/dashboard/resourceActions.ts"),
  "utf8",
);
const settings = readFileSync(
  resolve(root, "src/components/dashboard/ResourceSettings.tsx"),
  "utf8",
);
const booking = readFileSync(
  resolve(root, "src/components/booking/BookingSequenceFlow.tsx"),
  "utf8",
);

describe("parallel multi-service resource policy acceptance", () => {
  it("defaults resources and undeclared service pairs to sequential-only", () => {
    expect(migration).toMatch(
      /same_guest_parallel_capacity smallint NOT NULL DEFAULT 1/i,
    );
    expect(migration).toMatch(
      /CHECK \(same_guest_parallel_capacity BETWEEN 1 AND 2\)/i,
    );
    expect(migration).toContain("parallel_pair_not_allowed");
    expect(migration).toContain("no_shared_parallel_resource");
    expect(migration).toContain("booking_sequence_payment_policy_ready");
    expect(migration).toContain("'payment_policy_ready', true");
    expect(migration).toContain("multi_service_booking_rollout_authorized");
    expect(migration).toContain("salon_resource_booked_minutes_for_day");
  });

  it("permits same-booking shared capacity without weakening cross-booking exclusion", () => {
    expect(migration).toMatch(
      /booking_service_segments_resource_no_overlap[\s\S]*?booking_id WITH <>[\s\S]*?tstzrange/i,
    );
    expect(migration).toContain("CREATE TRIGGER enforce_parallel_segment_policy");
    expect(migration).toMatch(/v_prior\.staff_id = NEW\.staff_id/i);
    expect(migration).toMatch(/v_same_resource_overlap_count > v_resource_capacity/i);
  });

  it("exposes owner configuration but keeps tenant ownership enforced", () => {
    expect(migration).toContain('CREATE POLICY "owners manage service parallel policies"');
    expect(migration).toMatch(/member\.role IN \('owner', 'admin'\)/i);
    expect(actions).toContain("sameGuestParallelCapacity");
    expect(actions).toContain("saveParallelServicePolicy");
    expect(settings).toContain("Cặp dịch vụ được làm cùng lúc");
    expect(settings).toContain("Chung một ghế/giường");
  });

  it("lets the guest request parallel timing and explains fail-closed outcomes", () => {
    expect(booking).toContain('value="parallel"');
    expect(booking).toContain("parallel_pair_not_allowed");
    expect(booking).toContain("✓ Làm cùng lúc — 2 nhân viên");
    expect(booking).toContain("normalizeEditableLineTiming");
  });
});
