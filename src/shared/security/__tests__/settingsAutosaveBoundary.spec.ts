import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const hook = source(
  "src/components/dashboard/useImmediateSettingSave.ts",
);
const actions = source("src/shared/dashboard/salonOwnerActions.ts");

describe("safe Settings autosave boundary", () => {
  it("serializes writes and rolls failed selections back to server-confirmed state", () => {
    expect(hook).toContain("if (isSaving.current");
    expect(hook).toContain("const previousValue = committedValue.current");
    expect(hook).toContain("committedValue.current = result.value");
    expect(hook).toContain("setValue(previousValue)");
    expect(hook).toContain('setStatus("error")');
  });

  it.each([
    "BookingLeadSettings.tsx",
    "GroupTogetherSettings.tsx",
  ])("%s exposes saving outcomes to assistive technology", (filename) => {
    const component = source(`src/components/dashboard/${filename}`);
    expect(component).toContain('role="status"');
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("useImmediateSettingSave");
    expect(component).toContain('from "@/components/ui/Button"');
  });

  it("keeps group-booking settings aligned with owner/admin permissions", () => {
    const start = actions.indexOf(
      "export async function updateGroupTogetherThreshold(",
    );
    const next = actions.indexOf("\nexport async function ", start + 1);
    const action = actions.slice(start, next < 0 ? undefined : next);

    expect(start).toBeGreaterThan(-1);
    expect(action).toContain("if (!isOwnerOrAdmin(ctx.role))");
    expect(action).not.toContain('ctx.role !== "owner"');
  });

  it("keeps the wave policy aligned with owner/admin booking-settings access", () => {
    const start = actions.indexOf(
      "export async function updateGroupWaveStrategy(",
    );
    const next = actions.indexOf("\nexport async function ", start + 1);
    const action = actions.slice(start, next < 0 ? undefined : next);

    expect(start).toBeGreaterThan(-1);
    expect(action).toContain("if (!isOwnerOrAdmin(ctx.role))");
    expect(action).toContain("isGroupWaveStrategy(strategy)");
    expect(action).toContain('.eq("id", ctx.salon.id)');
  });
});
