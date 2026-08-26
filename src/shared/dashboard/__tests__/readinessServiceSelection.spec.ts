import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectReadinessServices } from "@/shared/dashboard/readinessServiceSelection";

const main = {
  id: "main-service",
  priceCents: 4500,
  durationMinutes: 45,
  isAddon: false,
};
const addon = {
  id: "addon-service",
  priceCents: 1000,
  durationMinutes: 10,
  isAddon: true,
};

describe("readiness service selection", () => {
  it("preserves all non-deleted services for legacy flag-off salons", () => {
    expect(selectReadinessServices([main, addon], false)).toEqual([
      { id: "main-service", priceCents: 4500, durationMinutes: 45 },
      { id: "addon-service", priceCents: 1000, durationMinutes: 10 },
    ]);
  });

  it("uses only main bookable services for the Guided QA pilot", () => {
    expect(selectReadinessServices([main, addon], true)).toEqual([
      { id: "main-service", priceCents: 4500, durationMinutes: 45 },
    ]);
  });

  it("uses the real services schema instead of a nonexistent status column", () => {
    const loader = readFileSync(
      resolve(process.cwd(), "src/shared/dashboard/loadGoLiveReadiness.ts"),
      "utf8",
    );
    const servicesSelect = loader.match(
      /\.from\("services"\)[\s\S]*?\.select\(\s*("[^"]+")\s*,?\s*\)/,
    )?.[1];

    expect(servicesSelect).toContain("price_max_cents");
    expect(servicesSelect).toContain("buffer_minutes");
    expect(servicesSelect).not.toContain("status");
    expect(loader).toContain('.is("deleted_at" as never, null)');

    const folded = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260723000000_folded_production_schema_baseline.sql",
      ),
      "utf8",
    );
    const servicesTable = folded.match(
      /CREATE TABLE public\.services \(([\s\S]*?)\n\);/,
    )?.[1];
    expect(servicesTable).toBeDefined();
    for (const column of [
      "id uuid",
      "name text",
      "description text",
      "price_cents integer",
      "price_type text",
      "price_max_cents integer",
      "duration_minutes integer",
      "buffer_minutes integer",
      "is_addon boolean",
      "deleted_at timestamp",
    ]) {
      expect(servicesTable).toContain(column);
    }
    expect(servicesTable).not.toMatch(/^\s*status\s/m);

    const salonsTable = folded.match(
      /CREATE TABLE public\.salons \(([\s\S]*?)\n\);/,
    )?.[1];
    expect(salonsTable).toContain("booking_lead_minutes integer");
    expect(salonsTable).toContain("resources_enabled boolean");
    expect(salonsTable).toContain("staff_selection_enabled boolean");

    const shiftsTable = folded.match(
      /CREATE TABLE public\.staff_shifts \(([\s\S]*?)\n\);/,
    )?.[1];
    expect(shiftsTable).toContain("day_of_week text");
    expect(shiftsTable).toContain("start_time text");
    expect(shiftsTable).toContain("end_time text");
  });
});
