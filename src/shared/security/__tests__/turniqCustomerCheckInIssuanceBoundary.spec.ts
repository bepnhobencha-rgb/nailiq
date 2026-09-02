import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20260902124728_add_turniq_customer_checkin_shadow_ledger.sql");
const actions = read("src/shared/turniq/customerCheckInActions.ts");
const publicPage = read("src/app/turniq/check-in/page.tsx");
const publicClient = read("src/app/turniq/check-in/TurnIqPublicCheckInClient.tsx");
const manager = read("src/app/dashboard/[slug]/turniq/check-in/TurnIqCheckInLinkManager.tsx");

describe("TurnIQ M4N authenticated issuance and public check-in boundary", () => {
  it("requires a real front-desk member plus salon and explicit platform flags", () => {
    expect(actions).toContain('ctx.kind !== "member"');
    expect(actions).toContain("isFrontDeskRole(ctx.role)");
    expect(actions).toContain('isReleaseFeatureVisible(ctx.salon, "turniq_trust_engine")');
    expect(actions).toContain('error: "preview_only"');
  });

  it("keeps the raw capability in the fragment and out of persistent storage", () => {
    expect(actions).toContain("#cap=");
    expect(actions).not.toMatch(/checkInPath:[^\n]*\?[^\n]*token=/);
    expect(publicClient).toContain("window.location.hash");
    expect(publicClient).toContain("sessionStorage.setItem(storageKey, JSON.stringify(persisted))");
    expect(publicClient).not.toMatch(/sessionStorage\.setItem\([^\n]*token/);
    expect(publicPage).toContain('referrer: "no-referrer"');
  });

  it("makes revocation same-salon, authorized, idempotent and irreversible", () => {
    expect(migration).toContain("revoke_turniq_customer_checkin_capability_v1");
    expect(migration).toContain("sm.role IN ('owner', 'admin', 'senior', 'receptionist')");
    expect(migration).toContain("c.salon_id = p_salon_id");
    expect(migration).toContain("revocation is irreversible");
    expect(migration).toContain("v_replayed := true");
  });

  it("keeps customer and manager surfaces free of provider and booking mutation calls", () => {
    expect(`${publicPage}\n${publicClient}\n${manager}\n${actions}`).not.toMatch(
      /createPayment|sendSms|sendEmail|twilio|resend|squareClient|stripeClient|\.insert\(|\.update\(|\.delete\(/i,
    );
    expect(manager).toContain("never creates a booking or assignment");
  });
});
