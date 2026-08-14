import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/shared/dashboard/sendOwnerBookingNotification.ts",
  ),
  "utf8",
);

describe("owner booking notification tenant boundary", () => {
  it("loads a booking only through its composite booking and salon identity", () => {
    const bookingRead = source.slice(
      source.indexOf("// Booking details + service/staff names."),
      source.indexOf("const b = bRow as"),
    );

    expect(bookingRead).toContain('.eq("id", bookingId)');
    expect(bookingRead).toContain('.eq("salon_id", salonId)');
    expect(bookingRead.indexOf('.eq("id", bookingId)')).toBeLessThan(
      bookingRead.indexOf('.eq("salon_id", salonId)'),
    );
  });

  it("fails closed and records both query failure and cross-tenant absence", () => {
    expect(source).toContain("if (bookingReadError || !bRow)");
    expect(source).toContain('"booking_read_failed"');
    expect(source).toContain('"booking_not_in_salon"');
    expect(source).toContain('status: "skipped"');
  });

  it("keeps service and staff detail joins inside the same salon", () => {
    const detailRead = source.slice(
      source.indexOf("const [svcRes, staffRes, profRes]"),
      source.indexOf("const svc = svcRes.data"),
    );
    expect(detailRead).toContain('.from("services")');
    expect(detailRead).toContain('.from("staff")');
    expect(detailRead.match(/\.eq\("salon_id", salonId\)/g)).toHaveLength(2);
    expect(detailRead).toContain('error: "booking_detail_read_failed"');
  });
});
