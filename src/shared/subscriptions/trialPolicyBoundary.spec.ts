import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260915143000_add_versioned_trial_entitlement_boundary.sql",
  "utf8",
);
const registration = readFileSync(
  "src/shared/register/completeSalonRegistrationAction.ts",
  "utf8",
);
const publicBooking = readFileSync(
  "src/shared/booking/submitPublicBooking.ts",
  "utf8",
);
const groupBooking = readFileSync(
  "src/shared/booking/submitGroupBooking.ts",
  "utf8",
);
const deskBooking = readFileSync(
  "src/shared/dashboard/receptionistActions.ts",
  "utf8",
);

describe("versioned trial policy boundaries", () => {
  it("enrolls new registrations without bulk-changing existing salons", () => {
    expect(registration).toContain(
      "withTrialExpiryPolicy(withCocoSetupActivation(null))",
    );
    expect(migration).not.toMatch(/UPDATE\s+public\.salons/i);
    expect(migration).toContain("THEN 'legacy'");
  });

  it("blocks new bookings at the database boundary with a typed rejection", () => {
    expect(migration).toMatch(
      /BEFORE INSERT ON public\.bookings[\s\S]*enforce_trial_new_booking_boundary/i,
    );
    expect(migration).toContain("ERRCODE = 'NITRL'");
    expect(migration).toContain("MESSAGE = 'trial_new_booking_paused'");
    expect(publicBooking).toContain('rpcErr.code === "NITRL"');
    expect(publicBooking).toContain('new Error("trial_new_booking_paused")');
    expect(groupBooking).toContain('rpcErr.code === "NITRL"');
    expect(deskBooking).toContain('code === "NITRL"');
  });

  it("keeps booking servicing only in continuity and makes it read-only after day seven", () => {
    expect(migration).toContain("s.trial_ends_at + interval '7 days'");
    expect(migration).toContain("v_state = 'trial_read_only'");
    expect(migration).toContain("OLD.created_at >= v_trial_ends_at");
  });

  it("blocks new charge claims but leaves refund operation kinds outside the block", () => {
    expect(migration).toContain(
      "'deposit_charge', 'noshow_charge', 'late_cancel_charge'",
    );
    expect(migration).not.toMatch(
      /NEW\.operation_kind NOT IN \([\s\S]{0,120}'deposit_refund'/,
    );
    expect(migration).toContain("trial_new_charge_paused");
  });

  it("does not expose tenant billing metadata through the public capability", () => {
    expect(migration).toMatch(
      /FUNCTION public\.public_salon_accepts_new_bookings\([\s\S]*?RETURNS boolean/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.tenant_trial_entitlement_state[\s\S]*?FROM PUBLIC, anon, authenticated/i,
    );
  });
});
