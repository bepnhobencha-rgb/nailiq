import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public booking write boundary", () => {
  it("keeps anonymous direct booking inserts revoked and fail-closed", () => {
    const dir = resolve(process.cwd(), "supabase/migrations");
    const migrations = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(resolve(dir, name), "utf8"));
    const latestPolicy = migrations
      .filter((sql) => /(?:CREATE|create) POLICY bookings_insert_anon/.test(sql))
      .at(-1);

    expect(latestPolicy).toBeDefined();
    expect(latestPolicy).toMatch(/REVOKE INSERT ON TABLE public\.bookings FROM anon/i);
    expect(latestPolicy).toMatch(/WITH CHECK \(false\)/i);
  });

  it("keeps anonymous group bookings behind validation and abuse controls", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260722201500_harden_public_group_booking.sql",
      ),
      "utf8",
    );

    expect(migration).toMatch(/RENAME TO insert_group_bookings_unlimited/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.insert_group_bookings_unlimited\(jsonb\)/i);
    expect(migration).toMatch(/s\.id = v_service_id AND s\.salon_id = v_salon_id/i);
    expect(migration).toMatch(/st\.id = v_staff_id AND st\.salon_id = v_salon_id/i);
    expect(migration).toMatch(/jsonb_build_object\('price_cents', v_price\)/i);
    expect(migration).toMatch(/public-group-booking:salon:/i);
    expect(migration).toMatch(/public-group-booking:phone:/i);
  });

  it("binds public customer snapshots to a recent unguessable booking", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260722203000_bind_client_snapshot_to_booking.sql",
      ),
      "utf8",
    );

    expect(migration).toMatch(/p_booking_id uuid/i);
    expect(migration).toMatch(/b\.id = p_booking_id/i);
    expect(migration).toMatch(/b\.salon_id = p_salon_id/i);
    expect(migration).toMatch(/b\.created_at >= now\(\) - interval '10 minutes'/i);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_booking_client_snapshot\(uuid, text\)[\s\S]*FROM PUBLIC, anon, authenticated/i,
    );
  });

  it("keeps queue and review PII closed to public table reads", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260722205000_close_public_pii_reads.sql",
      ),
      "utf8",
    );

    expect(migration).toMatch(/DROP POLICY IF EXISTS anon_read_queue_entries/i);
    expect(migration).toMatch(
      /REVOKE SELECT ON TABLE public\.queue_entries FROM anon/i,
    );
    expect(migration).toMatch(/DROP POLICY IF EXISTS reviews_select_by_token/i);
    expect(migration).toMatch(
      /REVOKE SELECT ON TABLE public\.reviews FROM anon, authenticated/i,
    );
  });

  it("keeps loyalty phones and OTP session rows private", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260722210600_close_loyalty_otp_reads.sql",
      ),
      "utf8",
    );

    expect(migration).toMatch(
      /REVOKE SELECT ON TABLE public\.loyalty_cards FROM anon/i,
    );
    expect(migration).toMatch(/p_session_id uuid[\s\S]*p_salon_id uuid[\s\S]*p_phone text/i);
    expect(migration).toMatch(/s\.id = p_session_id/i);
    expect(migration).toMatch(
      /REVOKE SELECT ON TABLE public\.phone_otp_sessions FROM anon/i,
    );

    const baseline = readFileSync(
      resolve(process.cwd(), "scripts/apply-baseline.sh"),
      "utf8",
    );
    expect(baseline).toContain(
      "20260722210600_close_loyalty_otp_reads.sql",
    );
  });

  it("keeps owner, billing and internal salon fields out of anonymous reads", () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260722214100_harden_public_salon_reads.sql",
      ),
      "utf8",
    );

    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.salons FROM anon/i,
    );
    expect(migration).toMatch(/GRANT SELECT \([\s\S]*\) ON TABLE public\.salons TO anon/i);
    for (const privateColumn of [
      "email",
      "owner_phone",
      "stripe_customer_id",
      "stripe_subscription_id",
      "admin_notes",
      "ai_manager_instructions",
    ]) {
      expect(migration.match(/GRANT SELECT \(([\s\S]*?)\) ON TABLE/i)?.[1]).not.toMatch(
        new RegExp(`\\b${privateColumn}\\b`, "i"),
      );
    }

    const lookup = readFileSync(
      resolve(process.cwd(), "src/shared/booking/getSalonBySlug.ts"),
      "utf8",
    );
    expect(lookup).not.toMatch(/\.from\("salons"\)[\s\S]{0,120}\.select\("\*"\)/);
  });
});
