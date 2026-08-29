import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260824234619_enforce_v1_terminal_booking_policy.sql",
  ),
  "utf8",
);
const actions = readFileSync(
  resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
  "utf8",
);
const center = readFileSync(
  resolve(process.cwd(), "src/components/receptionist/ReceptionistCenter.tsx"),
  "utf8",
);
const noShowSafetyMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829024500_add_no_show_safety_boundary.sql",
  ),
  "utf8",
);

describe("V1 terminal booking correction policy", () => {
  it("hard-offs linked archived recovery in the database", () => {
    expect(migration).toContain(
      "archived booking recovery is unavailable in V1",
    );
    expect(migration).toMatch(
      /old\.recovered_from_booking_id IS NULL[\s\S]*new\.recovered_from_booking_id IS NOT NULL/u,
    );
    expect(migration).toContain("booking recovery metadata is immutable");
  });

  it("makes terminal identity and schedule immutable", () => {
    for (const column of [
      "salon_id",
      "source",
      "booking_channel",
      "service_id",
      "staff_id",
      "resource_id",
      "group_id",
      "client_profile_id",
      "client_name",
      "client_phone",
      "client_email",
      "client_notes",
      "start_time_utc",
      "end_time_utc",
      "price_cents",
      "deleted_at",
    ]) {
      expect(migration).toContain(
        `old.${column} IS DISTINCT FROM new.${column}`,
      );
    }
    expect(migration).toMatch(
      /old\.client_profile_id IS NOT NULL[\s\S]*new\.client_profile_id IS NULL/u,
    );
  });

  it("couples terminal transitions and their acceptance audit", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.enforce_v1_terminal_booking_policy\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path TO ''/u,
    );
    expect(migration).toContain(
      "'terminal_booking_transition_authorized'",
    );
    expect(migration).toContain("'source', 'v1_terminal_booking_policy'");
    expect(migration).toContain("pg_catalog.clock_timestamp()");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.enforce_v1_terminal_booking_policy\(\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/u,
    );
  });

  it("keeps only the scoped eight-second cancel undo", () => {
    expect(migration).toContain("interval '8 seconds'");
    expect(migration).toContain("nailiq.v1_terminal_undo_booking_id");
    expect(migration).toContain(
      "terminal booking restore is unavailable in V1",
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.undo_recent_cancelled_booking_v1\([\s\S]*FOR UPDATE[\s\S]*'undo_window_expired'/u,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.undo_recent_cancelled_booking_v1\([\s\S]*FROM PUBLIC, anon, authenticated[\s\S]*GRANT EXECUTE[\s\S]*TO service_role/u,
    );
  });

  it("routes terminal writes through the service-only transaction", () => {
    for (const reason of ["walkin_removed", "desk_cancel", "wix_decline"]) {
      expect(actions).toContain(`reason: "${reason}"`);
    }
    expect(actions).toContain('"transition_booking_to_terminal_v1" as never');
    expect(actions).toContain('"undo_recent_cancelled_booking_v1" as never');
    expect(actions).not.toContain('reason: "desk_no_show"');
    expect(actions).toContain('"begin_booking_no_show_v1" as never');
    expect(actions).toContain("finalizeAndProcessNoShowDecision");
  });

  it("hard-offs long-lived restore while allowing only pending no-show undo", () => {
    expect(actions).toMatch(
      /undoNoShowBooking[\s\S]*"undo_booking_no_show_v1" as never/u,
    );
    expect(noShowSafetyMigration).toContain("clock_timestamp() >= v_decision.commit_after");
    expect(noShowSafetyMigration).toContain("'undo_window_expired'");
    expect(actions).toMatch(
      /restoreCancelledBooking[\s\S]*return fail\("phase_2_not_available"\)/u,
    );
    expect(center).toContain("v1AllowsLongLivedTerminalCorrection");
    expect(center).toMatch(
      /drawerRestoreAction\s*=[\s\S]*v1AllowsLongLivedTerminalCorrection[\s\S]*!archivedBookingRecoveryEnabled/u,
    );
    expect(center).toContain("onUndoNoShow={undefined}");
    expect(center).toContain('type: "assign" | "cancel" | "no_show"');
  });
});
