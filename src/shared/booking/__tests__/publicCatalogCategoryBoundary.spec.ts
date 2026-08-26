import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("public booking category tenant boundary", () => {
  it("groups only salon-scoped primary services from the narrow public catalog", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/shared/booking/loadBookingServices.ts"),
      "utf8",
    );
    const catalogStart = source.indexOf('.from("public_service_catalog")');
    const staffStart = source.indexOf('.from("public_staff_profiles")', catalogStart);
    const catalogQuery = source.slice(catalogStart, staffStart);

    expect(catalogStart).toBeGreaterThan(-1);
    expect(catalogQuery).toContain('.eq("salon_id", salonId)');
    expect(catalogQuery).toContain('.order("name", { ascending: true })');
    expect(source).toContain(".filter((r) => !isAddonRow(r))");
    expect(source).toContain(".filter(isAddonRow)");
  });
});
