import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260724015000_use_security_invoker_public_views.sql",
  ),
  "utf8",
);

const rollback = readFileSync(
  resolve(
    process.cwd(),
    "scripts/security/rehearse-public-view-invoker-rollback.sql",
  ),
  "utf8",
);

describe("public view invoker boundary", () => {
  it("removes view-owner execution from every public booking view", () => {
    for (const view of [
      "public_salon_profiles",
      "public_service_catalog",
      "public_staff_profiles",
      "public_staff_shifts",
      "public_staff_unavailability",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER VIEW public\\.${view} SET \\(security_invoker = true\\)`,
          "i",
        ),
      );
      expect(rollback).toMatch(
        new RegExp(
          `ALTER VIEW public\\.${view} RESET \\(security_invoker\\)`,
          "i",
        ),
      );
    }
  });

  it("keeps private salon, staff identity and time-off columns ungranted", () => {
    const grantedColumns = Array.from(
      migration.matchAll(
        /GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.(?:salons|services|staff|staff_shifts|staff_unavailability) TO anon/gi,
      ),
      (match) => match[1],
    ).join(",");

    for (const privateColumn of [
      "email",
      "phone",
      "owner_phone",
      "stripe_customer_id",
      "stripe_subscription_id",
      "admin_notes",
      "ai_manager_instructions",
      "user_id",
      "wix_resource_id",
      "square_team_member_id",
      "reason",
    ]) {
      expect(grantedColumns).not.toMatch(
        new RegExp(`\\b${privateColumn}\\b`, "i"),
      );
    }
  });

  it("uses a session-free anon client for all public booking entry points", () => {
    const publicClient = readFileSync(
      resolve(process.cwd(), "src/shared/lib/supabase/publicClient.ts"),
      "utf8",
    );
    expect(publicClient).toMatch(/persistSession:\s*false/);
    expect(publicClient).toMatch(/autoRefreshToken:\s*false/);

    for (const file of [
      "src/shared/booking/resolvePublicBookingPage.ts",
      "src/shared/booking/loadBookingServices.ts",
      "src/shared/booking/getAvailableTimeSlots.ts",
      "src/shared/booking/loadGroupDayTimeline.ts",
      "src/shared/booking/loadGroupSmartSchedule.ts",
      "src/shared/booking/submitGroupBooking.ts",
      "src/shared/booking/submitPublicBooking.ts",
      "src/shared/booking/submitPublicWaitlist.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain("@/shared/lib/supabase/publicClient");
      expect(source).not.toContain("@/shared/lib/supabase/client");
      expect(source).not.toContain("@/shared/lib/supabase/server");
    }
  });
});
