import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("deposit risk tenant boundary", () => {
  it("does not use a phone-only global profile/history read in the public intent", () => {
    const source = readFileSync(
      resolve(root, "src/app/api/booking/deposit-intent/route.ts"),
      "utf8",
    );
    expect(source).not.toContain('.from("client_profiles"');
    // Pricing, deposit policy and customer history are now resolved inside the
    // service-only canonical material RPC. The browser route must pass the
    // authoritative tenant explicitly and must not reconstruct history with a
    // phone-only table query.
    expect(source).not.toContain('.from("bookings" as never)');
    expect(source).toContain('"load_public_deposit_payment_material"');
    expect(source).toContain('"claim_public_deposit_payment_operation"');
    expect(source).toMatch(/const canonicalArgs = \{[\s\S]{0,700}?p_salon_id: salonId/);
  });

  it("binds desk deposit history to the booking salon and excludes the current row", () => {
    const source = readFileSync(
      resolve(root, "src/shared/integrations/square/deposits.ts"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(root, "supabase/migrations/20260820150000_add_authoritative_booking_payment_operations.sql"),
      "utf8",
    );
    expect(source).not.toContain('.from("client_profiles")');
    expect(source).toContain('"claim_booking_square_deposit_link"');
    expect(source).toMatch(/p_salon_id: salonId[\s\S]{0,180}?p_booking_id: bookingId/);
    const claimStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.claim_booking_square_deposit_link(",
    );
    expect(claimStart).toBeGreaterThan(-1);
    const claim = migration.slice(claimStart, claimStart + 9_000);
    expect(claim).toMatch(
      /FROM public\.bookings[\s\S]{0,180}?WHERE id=p_booking_id AND salon_id=p_salon_id FOR UPDATE/,
    );
    expect(claim).toMatch(
      /FROM public\.square_integrations[\s\S]{0,180}?WHERE salon_id=p_salon_id/,
    );
  });

  it("calls the deployed two-argument client snapshot contract after public create", () => {
    const source = readFileSync(
      resolve(root, "src/shared/booking/submitPublicBooking.ts"),
      "utf8",
    );
    const call = source.slice(
      source.indexOf('"get_booking_client_snapshot"'),
      source.indexOf('"get_booking_client_snapshot"') + 500,
    );
    expect(call).toContain("p_salon_id:");
    expect(call).toContain("p_phone:");
    expect(call).not.toContain("p_booking_id:");
  });

  it.each([
    "src/shared/integrations/square/noshow.ts",
    "src/shared/noshow/ensureNoShowCardRequirement.ts",
    "src/shared/noshow/agentNoShowPolicy.ts",
  ])("tenant-binds group payment/policy reads in %s", (path) => {
    const source = readFileSync(resolve(root, path), "utf8");
    const groupReads = source.match(
      /\.from\("bookings"(?: as never)?\)[\s\S]{0,250}?\.eq\("(?:salon_id|group_id)"(?: as never)?,[^\n]+\)[\s\S]{0,160}?\.eq\("(?:salon_id|group_id)"(?: as never)?,[^\n]+\)/g,
    );
    expect(groupReads?.some((read) =>
      read.includes('"salon_id"') && read.includes('"group_id"')
    )).toBe(true);
  });

  it("allows deposit skip only for an authoritative required:false response", () => {
    const source = readFileSync(
      resolve(root, "src/components/booking/BookingFlowDepositPanel.tsx"),
      "utf8",
    );
    expect(source.match(/onSkip\(\)/g)).toHaveLength(1);
    expect(source).toMatch(/data\.required === false[\s\S]{0,180}?onSkip\(\)/);
    expect(source).toMatch(
      /!res\.ok \|\| "error" in data[\s\S]{0,240}?setLoadError\("error" in data \? data\.error : "deposit_unavailable"\)/,
    );
  });
});
