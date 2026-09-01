import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const page = read("src/app/dashboard/[slug]/setup/preview/page.tsx");
const loader = read("src/shared/dashboard/loadGuidedBookingPreview.ts");
const availabilityAction = read(
  "src/shared/dashboard/loadGuidedBookingPreviewAvailability.ts",
);
const slotReader = read("src/shared/booking/getAvailableTimeSlots.ts");
const publicBookingLoader = read(
  "src/shared/booking/loadBookingServices.ts",
);
const simulator = read(
  "src/components/dashboard/GuidedBookingPreviewSimulator.tsx",
);
const action = read("src/shared/dashboard/goLiveAttestationAction.ts");
const publicRoute = read("src/app/[slug]/page.tsx");

describe("Guided booking preview security boundary", () => {
  it("uses a distinct authenticated dashboard route instead of the live public flow", () => {
    expect(page).toContain("loadGuidedBookingPreview(slug)");
    expect(page).toContain("GuidedBookingPreviewSimulator");
    expect(page).not.toContain("BookingTypeSwitcher");
    expect(page).not.toContain("submitPublicBooking");
    expect(page).not.toContain('href={`/${slug}`}');
    expect(publicRoute).not.toContain('searchParams.get("preview")');
  });

  it("authenticates an owner/admin, resolves the effective flag, and binds the exact salon", () => {
    expect(loader).toContain('import "server-only"');
    expect(loader).toContain("getDashboardWriteClient(slug)");
    expect(loader).toContain('ctx.kind !== "member"');
    expect(loader).toContain("isOwnerOrAdmin(ctx.role)");
    expect(loader).toContain(
      "isCocoSetupExperienceVisible(ctx.salon)",
    );
    expect(loader).toContain(
      "String(resolved.load.salon.id) !== String(ctx.salon.id)",
    );
    expect(loader).toContain("resolved.load.addOns.length > 0");
    expect(loader).toContain("resolved.load.combos.length > 0");
    expect(loader).toContain("resolved.load.proofComplete !== true");
    expect(loader).toContain("resolved.load.hasActivePromotions !== false");
    expect(loader).toContain(
      "resolved.load.salon.groupBookingEnabled === true",
    );
    expect(publicBookingLoader).toContain(
      "hasActivePromotions: promoList.length > 0",
    );
    expect(publicBookingLoader).toContain(
      "if (promotionsError) proofComplete = false",
    );
    expect(publicBookingLoader).toContain(
      "if (rulesError) proofComplete = false",
    );
  });

  it("keeps preview interactions read-only and the booking confirmation technically disabled", () => {
    expect(simulator).toContain('data-preview-read-only="true"');
    expect(simulator).toContain('data-testid="guided-preview-confirm-disabled"');
    expect(simulator).toContain("loadGuidedBookingPreviewAvailability");
    expect(simulator).toContain("disabled");
    expect(simulator).not.toMatch(/\bfetch\s*\(/);
    expect(simulator).not.toMatch(/\.rpc\s*\(/);
    expect(simulator).not.toMatch(/\.from\s*\(/);
    expect(simulator).not.toMatch(/<form\b/i);
    expect(simulator).not.toContain("submitPublicBooking");
    expect(simulator).not.toContain("submitGroupBooking");
    expect(simulator).not.toContain("submitPublicWaitlistEntry");
    expect(simulator).not.toMatch(/stripe|square|twilio|resend/i);
  });

  it("rechecks role, tenant, canonical selections, date window, and strict reads", () => {
    expect(availabilityAction).toContain('"use server"');
    expect(availabilityAction).toContain("loadGuidedBookingPreview(input.slug)");
    expect(availabilityAction).toContain("resource_mode_not_proven");
    expect(availabilityAction).toContain("getAvailableTimeSlotsStrict");
    expect(availabilityAction).toContain("eligibleStaffIds.has(requestedStaffId)");
    expect(availabilityAction).not.toMatch(
      /submitPublicBooking|submitGroupBooking|submitPublicWaitlistEntry/,
    );
    expect(availabilityAction).not.toMatch(/serviceRole|stripe|square|twilio|resend/i);
    expect(slotReader).toContain('mode === "strict"');
    expect(slotReader).toContain('reason: "unavailable"');
    expect(slotReader).toContain("isStrictOccupancyRow");
    expect(slotReader).toContain("isStrictShiftRow");
    expect(slotReader).toContain("isStrictUnavailableRow");
  });

  it("checks preview availability before recording rehearsal or final approval", () => {
    expect(action).toContain("loadGuidedBookingPreviewAvailability");
    expect(action).toContain("guidedPreviewSelection");
    expect(action).toContain('input.action === "attest"');
    expect(action).toContain('reason: "guided_preview_unavailable"');
    expect(action.indexOf("loadGuidedBookingPreviewAvailability")).toBeLessThan(
      action.indexOf('from("salon_go_live_attestations"'),
    );
  });
});
