import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const migration = read(
  "supabase/migrations/20260829024500_add_no_show_safety_boundary.sql",
);
const accessMigration = read(
  "supabase/migrations/20260829033000_deny_direct_no_show_decision_access.sql",
);
const actions = read("src/shared/dashboard/receptionistActions.ts");
const receptionist = read("src/components/receptionist/ReceptionistCenter.tsx");
const protectionHub = read("src/components/dashboard/NoShowProtectionHub.tsx");
const retryCron = read("src/app/api/cron/noshow-charge-retry/route.ts");
const reconciliationCron = read(
  "src/app/api/cron/payment-reconciliation/route.ts",
);
const squareNoShow = read("src/shared/integrations/square/noshow.ts");
const vercel = read("vercel.json");

function sqlFunction(name: string, nextName: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = migration.indexOf(
    `CREATE OR REPLACE FUNCTION public.${nextName}`,
    start + 1,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

function exportedFunction(name: string, nextName: string): string {
  const start = actions.indexOf(`export async function ${name}`);
  const end = actions.indexOf(`export async function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return actions.slice(start, end);
}

describe("V1 no-show safety boundary", () => {
  it("keeps decisions private, RPC-only, member-scoped, and reversible for 60 seconds", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.booking_no_show_decisions");
    expect(migration).toContain("CHECK (scope = 'booking_member')");
    expect(migration).toContain("commit_after >= requested_at + interval '60 seconds'");
    expect(migration).toContain(
      "ALTER TABLE public.booking_no_show_decisions ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.booking_no_show_decisions\s+FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.begin_booking_no_show_v1[\s\S]*?TO service_role/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.undo_booking_no_show_v1[\s\S]*?TO service_role/i,
    );
    expect(accessMigration).toContain("AS RESTRICTIVE");
    expect(accessMigration).toContain("USING (false)");
    expect(accessMigration).toContain("WITH CHECK (false)");
  });

  it("does not mutate booking, history, waitlist, notification, or money before commit", () => {
    const begin = sqlFunction("begin_booking_no_show_v1", "undo_booking_no_show_v1");
    const undo = sqlFunction("undo_booking_no_show_v1", "finalize_due_booking_no_shows_v1");
    for (const source of [begin, undo]) {
      expect(source).not.toMatch(/UPDATE public\.bookings/i);
      expect(source).not.toContain("no_show_count");
      expect(source).not.toMatch(/waitlist|notification|charge|refund/i);
    }
    expect(begin).toContain("v_now + interval '60 seconds'");
    expect(undo).toContain("state = 'undone'");
  });

  it("commits attendance atomically before durable provider-free effects", () => {
    const finalize = sqlFunction(
      "finalize_due_booking_no_shows_v1",
      "claim_booking_no_show_effects_v1",
    );
    expect(finalize).toContain("FOR UPDATE SKIP LOCKED");
    expect(finalize).toContain("UPDATE public.bookings b");
    expect(finalize).toContain("'history_scope', 'salon_booking'");
    expect(finalize).not.toContain("client_profiles");
    expect(finalize).toContain("customer_effect_status = 'suppressed_v1'");
    expect(finalize).not.toMatch(/square|twilio|charge|refund/i);
    expect(finalize.indexOf("UPDATE public.bookings b")).toBeLessThan(
      finalize.indexOf("SET state = 'committed'"),
    );

    const claim = sqlFunction(
      "claim_booking_no_show_effects_v1",
      "complete_booking_no_show_effects_v1",
    );
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim).toContain("effects_lease_token");
  });

  it("routes the desk through pending receipts and removes post-commit money controls", () => {
    const mark = exportedFunction("markNoShowBooking", "undoNoShowBooking");
    expect(mark).toContain('"begin_booking_no_show_v1"');
    expect(mark).toContain("requestId");
    expect(mark).not.toMatch(/chargeNoShowFee|sendOwnerBookingNotification|promoteAndDeliverWaitlist|bump_client_no_show/);

    expect(receptionist).toContain("scheduleNoShowFinalization");
    expect(receptionist).toContain("secondsRemaining");
    expect(receptionist).toContain("scope is one booking member only");
    expect(receptionist).not.toMatch(/chargeNoShowFeeManual|waiveNoShowFee|noShowChargeModal/);
    expect(protectionHub).not.toMatch(
      /chargeNoShowFeeFromProtection|waiveNoShowFeeFromProtection|sendNoShowFeeLinkFromProtection/,
    );
  });

  it("hard-blocks legacy no-show money paths before any provider client is created", () => {
    for (const functionName of ["chargeNoShowFee", "refundNoShowFee"] as const) {
      const start = squareNoShow.indexOf(`export async function ${functionName}`);
      const next = squareNoShow.indexOf("export async function ", start + 1);
      const source = squareNoShow.slice(start, next === -1 ? undefined : next);
      expect(source.indexOf("v1AllowsCustomerPaymentGateway")).toBeGreaterThanOrEqual(0);
      expect(source.indexOf("v1AllowsCustomerPaymentGateway")).toBeLessThan(
        source.indexOf("createServiceRoleClient"),
      );
    }
    expect(retryCron).not.toContain("chargeNoShowFee");
    expect(retryCron).toContain("moneyMovement: \"blocked_v1\"");
    expect(reconciliationCron).toContain("!v1AllowsCustomerPaymentGateway()");
    expect(reconciliationCron).toContain('"noshow_charge"');
    expect(reconciliationCron).toContain('"noshow_refund"');
    expect(vercel).toContain('"path": "/api/cron/noshow-charge-retry"');
    expect(vercel).toContain('"schedule": "*/1 * * * *"');
  });
});
