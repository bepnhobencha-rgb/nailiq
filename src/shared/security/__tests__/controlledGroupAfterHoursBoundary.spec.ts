import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/20260810104500_add_controlled_after_hours_group_insert.sql",
);

describe("controlled group after-hours boundary", () => {
  it("keeps the privileged insert private to service_role", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.insert_controlled_after_hours_group_bookings\(jsonb, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.insert_controlled_after_hours_group_bookings\(jsonb, uuid\)[\s\S]*TO service_role/i,
    );
  });

  it("requires an Owner/Admin actor, explicit active staff and the 120-minute cap", () => {
    expect(migration).toMatch(/sm\.role IN \('owner', 'admin'\)/i);
    expect(migration).toMatch(/st\.status = 'active'/i);
    expect(migration).toMatch(/st\.deleted_at IS NULL/i);
    expect(migration).toMatch(/v_after_hours < 1 OR v_after_hours > 120/i);
    expect(migration).toMatch(/after_hours_staff_consent = true/i);
    expect(migration).toMatch(/after_hours_approved_by = p_actor_user_id/i);
  });

  it("does not expose the privileged function to public, Voice or SMS modules", () => {
    for (const path of [
      "src/shared/booking/submitPublicBooking.ts",
      "src/shared/booking/submitGroupBooking.ts",
      "src/shared/voiceai/toolExecutor.ts",
      "src/app/api/twilio/inbound/route.ts",
    ]) {
      expect(read(path)).not.toMatch(
        /\.rpc\(\s*["']insert_controlled_after_hours_group_bookings["']/,
      );
    }
    expect(read("src/shared/dashboard/receptionistActions.ts")).toContain(
      "insert_controlled_after_hours_group_bookings",
    );
  });

  it("requires the desk UI to confirm staff consent before enabling creation", () => {
    const form = read("src/components/receptionist/DeskGroupForm.tsx");
    expect(form).toContain('data-testid="controlled-group-after-hours"');
    expect(form).toContain("everyMemberHasSpecificStaff");
    expect(form).toContain("afterHoursConsent");
    expect(form).toContain("staffConsentConfirmed: true");
  });
});
