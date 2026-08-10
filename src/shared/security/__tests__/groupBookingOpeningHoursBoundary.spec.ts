import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260810082707_enforce_group_booking_opening_hours.sql",
  ),
  "utf8",
);

describe("group booking opening-hours database boundary", () => {
  it("derives service and add-on timing from the catalog", () => {
    expect(migration).toMatch(/FROM public\.services s/i);
    expect(migration).toMatch(/addon_service_ids/i);
    expect(migration).toMatch(/s\.addon_timing/i);
    expect(migration).toMatch(/v_service_completion/i);
  });

  it("rejects closed dates and service completion after close", () => {
    expect(migration).toMatch(/booking_closed_dates/i);
    expect(migration).toMatch(/jsonb_array_elements_text\(v_closed_dates\)/i);
    expect(migration).toMatch(/v_completion_local::time > v_close/i);
    expect(migration).toMatch(/'outside_hours'/i);
  });

  it("keeps the anonymous SECURITY DEFINER boundary least-privileged", () => {
    expect(migration).toMatch(/SECURITY DEFINER/i);
    expect(migration).toMatch(/SET search_path TO 'public'/i);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.insert_group_bookings\(jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.insert_group_bookings\(jsonb\)[\s\S]*TO anon, service_role/i,
    );
  });
});
