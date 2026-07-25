import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260725182854_allow_salon_scoped_booking_events.sql",
);

describe("salon-scoped booking events migration", () => {
  it("allows audit events that are not tied to a booking", () => {
    const migration = fs.readFileSync(migrationPath, "utf8");

    expect(migration).toMatch(
      /ALTER\s+TABLE\s+public\.booking_events\s+ALTER\s+COLUMN\s+booking_id\s+DROP\s+NOT\s+NULL/i,
    );
  });
});
