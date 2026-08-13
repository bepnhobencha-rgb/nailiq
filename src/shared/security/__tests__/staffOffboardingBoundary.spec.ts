import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/shared/dashboard/staffOffboardingActions.ts"),
  "utf8",
);

describe("staff offboarding safety boundary", () => {
  it("authorizes every entry point as owner/admin", () => {
    expect(source.match(/getDashboardWriteClient\(slug\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/isOwnerOrAdmin\(ctx\.role\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("scopes staff and appointment writes to the resolved salon", () => {
    expect(source).toContain('.eq("salon_id", ctx.salon.id)');
    expect(source).toContain('.eq("staff_id", input.staffId)');
  });

  it("blocks waiting/in-service visits and requires every future booking assignment", () => {
    expect(source).toContain('const BLOCKING = ["in_progress", "waiting"]');
    expect(source).toContain('return fail("operational_booking_blocked")');
    expect(source).toContain('return fail("assign_every_booking")');
  });

  it("only reassigns pending/confirmed visits and preserves their time, price, and service", () => {
    expect(source).toContain('const REASSIGNABLE = ["pending", "confirmed"]');
    expect(source).toContain('.update({ staff_id: nextStaffId })');
    expect(source).not.toContain(".update({ price_cents:");
    expect(source).not.toContain(".update({ start_time_utc:");
    expect(source).not.toContain(".update({ service_id:");
  });

  it("deactivates the profile without deleting staff or detaching completed history", () => {
    expect(source).toContain('.update({ status: "inactive" })');
    expect(source).not.toMatch(/\.from\("staff"\)[\s\S]{0,120}\.delete\(\)/);
    expect(source).not.toMatch(/\.from\("bookings"\)[\s\S]{0,120}\.delete\(\)/);
  });

  it("clears stale customer preferences using the verified staff UUID", () => {
    const preferenceCleanup = source.slice(
      source.indexOf('.from("client_profiles")'),
      source.indexOf("if (preferenceErr)"),
    );
    expect(preferenceCleanup).toContain(
      '.eq("preferred_staff_id", input.staffId)',
    );
    expect(preferenceCleanup).not.toContain('.eq("salon_id"');
    expect(source).toContain('return fail("preference_cleanup_failed")');
  });

  it("does not cancel appointments and records an attributed audit event", () => {
    expect(source).not.toContain('status: "cancelled"');
    expect(source).toContain('reason: "staff_offboarding"');
    expect(source).toContain("actorUserId: ctx.userId");
  });
});
