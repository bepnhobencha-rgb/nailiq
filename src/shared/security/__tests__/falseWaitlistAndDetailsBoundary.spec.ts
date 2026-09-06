import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");
const route = read("src/app/api/booking/capacity-rescue/route.ts");
const availability = read(
  "src/shared/booking/verifyIndividualWaitlistAvailability.ts",
);
const migration = read(
  "supabase/migrations/20260904230314_guard_public_waitlist_availability.sql",
);
const atomicMigration = read(
  "supabase/migrations/20260905204123_enforce_atomic_individual_waitlist_capacity.sql",
);
const nonIndividualHotfix = read(
  "supabase/migrations/20260906151600_fix_capacity_rescue_non_individual_record.sql",
);
const publicRpcGrantCheck = read(
  "scripts/security/check-public-rpc-role-grants.sql",
);
const loader = read("src/shared/dashboard/loadReceptionistCenterData.ts");
const panel = read("src/components/receptionist/OnlineWaitlistPanel.tsx");
const drawer = read("src/components/ui/Drawer.tsx");

describe("False Waitlist and private customer detail boundary", () => {
  it("fails closed at a same-origin server boundary before the durable insert", () => {
    expect(route).toContain("sameOrigin(request)");
    expect(route).toContain("verifyIndividualWaitlistAvailability");
    expect(route.indexOf("verifyIndividualWaitlistAvailability")).toBeLessThan(
      route.indexOf('"create_public_capacity_rescue_request_v2"'),
    );
    expect(route).toContain('code: "availability_unverified"');
    expect(route).toContain('code: "slot_available"');
    expect(availability).toContain("getAvailableTimeSlotsStrict");
    expect(availability).toContain("proofComplete");
  });

  it("makes the database a second fail-closed authority and keeps its audit PII-free", () => {
    expect(route).toContain('"create_public_capacity_rescue_request_v2"');
    expect(route).toContain('from("capacity_rescue_decision_events")');
    expect(atomicMigration).toContain(
      "public.evaluate_individual_waitlist_capacity",
    );
    expect(atomicMigration).toContain(
      "CREATE TRIGGER reject_false_individual_waitlist_entry",
    );
    expect(atomicMigration).toContain("v_capacity.outcome = 'slot_available'");
    expect(atomicMigration).toContain(
      "v_capacity.outcome <> 'slot_unavailable'",
    );
    expect(atomicMigration).toContain(
      "ALTER TABLE public.capacity_rescue_decision_events ENABLE ROW LEVEL SECURITY",
    );
    expect(atomicMigration).toContain("FROM PUBLIC, anon, authenticated");

    const auditDefinition = atomicMigration.slice(
      atomicMigration.indexOf(
        "CREATE TABLE IF NOT EXISTS public.capacity_rescue_decision_events",
      ),
      atomicMigration.indexOf(
        ");",
        atomicMigration.indexOf(
          "CREATE TABLE IF NOT EXISTS public.capacity_rescue_decision_events",
        ),
      ),
    );
    expect(auditDefinition).not.toContain("client_name");
    expect(auditDefinition).not.toContain("client_phone");
    expect(auditDefinition).not.toContain("client_email");
    expect(publicRpcGrantCheck).toContain(
      "('public.create_public_capacity_rescue_request_v2(uuid,uuid,text,uuid,uuid,date,text,integer,text,text,text,text,jsonb,text)', false, false)",
    );
    expect(publicRpcGrantCheck).toContain(
      "('public.evaluate_individual_waitlist_capacity(uuid,uuid,uuid,date,text)', false, false)",
    );
  });

  it("keeps retry idempotency ahead of changing live availability", () => {
    expect(route.indexOf('from("booking_waitlist_entries")')).toBeLessThan(
      route.lastIndexOf("verifyIndividualWaitlistAvailability"),
    );
    expect(route).toContain("request_id_conflict");
    expect(route).toContain("createdNew: false");
  });

  it("initializes the capacity trace before sequence or group requests use the v2 wrapper", () => {
    expect(nonIndividualHotfix).toContain(
      "NULL::integer AS eligible_staff_count",
    );
    expect(nonIndividualHotfix.indexOf("INTO v_capacity;")).toBeLessThan(
      nonIndividualHotfix.indexOf("IF EXISTS ("),
    );
    expect(nonIndividualHotfix).toContain(
      "CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_staff_count ELSE NULL END",
    );
    expect(nonIndividualHotfix).toContain(
      "FROM PUBLIC, anon, authenticated",
    );
    expect(nonIndividualHotfix).toContain("TO service_role");
  });

  it("removes direct anonymous execution and preserves source provenance", () => {
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration).toContain("TO service_role");
    expect(migration).toContain("normalize_capacity_rescue_waitlist_source");
    expect(migration).toContain("NEW.source := v_source");
    expect(migration).not.toContain("pg_catalog.nullif");
    expect(migration).not.toContain("pg_catalog.coalesce");
    expect(migration).toContain("NULLIF(pg_catalog.btrim(NEW.source), '')");
    expect(publicRpcGrantCheck).toContain(
      "('public.create_public_capacity_rescue_request(uuid,uuid,text,uuid,uuid,date,text,integer,text,text,text,text,jsonb)', false, false)",
    );
    expect(publicRpcGrantCheck).toContain(
      "('public.create_public_waitlist_entry(uuid,uuid,uuid,date,text,text,text,text,text)', false, false)",
    );
  });

  it("keeps full PII in the authenticated loader and out of the compact row", () => {
    expect(loader.indexOf("if (!ctx)")).toBeLessThan(
      loader.indexOf("createServiceRoleClient()"),
    );
    expect(loader).toContain('.eq("salon_id", ctx.salon.id)');
    expect(loader).toContain("client_email");
    expect(panel).toContain('data-testid="waitlist-customer-details"');
    expect(panel).toContain("maskPhone(entry.phone)");
    expect(panel).toContain("maskEmail(entry.email)");
    expect(panel).toContain("aria-label={t.openCustomerDetails(name)}");
    expect(panel).toContain("closeButtonLabel={t.closeDetails}");
    expect(drawer).toContain('if (e.key === "Escape")');
    expect(drawer).toContain("lastFocusedRef.current?.focus?.()");
    expect(drawer).toContain("FOCUSABLE_SELECTORS");
    expect(panel).not.toContain(
      '<p className="mt-0.5 truncate font-mono text-xs text-nq-muted">\n                        {entry.phone}\n                      </p>',
    );
  });
});
