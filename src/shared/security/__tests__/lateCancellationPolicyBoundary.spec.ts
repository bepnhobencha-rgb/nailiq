import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("late-cancellation policy boundary", () => {
  const migration = read(
    "supabase/migrations/20260807071017_lock_late_cancel_policy_across_customer_reschedule.sql",
  );
  const cancelRoute = read("src/app/api/booking/cancel-action/route.ts");
  const voiceExecutor = read("src/shared/voiceai/toolExecutor.ts");
  const voiceTools = read("src/shared/voiceai/realtimeTools.ts");

  it("locks the fee snapshot inside the same customer reschedule transaction", () => {
    expect(migration).toContain("self_cancel_fee_locked_at");
    expect(migration).toContain("self_cancel_fee_locked_cents");
    expect(migration).toContain("v_booking.start_time_utc < v_now + make_interval");
    expect(migration).toContain("self_cancel_fee_lock_reason");
  });

  it("keeps the customer RPC server-only after replacing the function", () => {
    expect(migration).toMatch(
      /revoke all on function public\.reschedule_booking_as_customer[\s\S]*from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.reschedule_booking_as_customer[\s\S]*to service_role/i,
    );
  });

  it("uses the same server-authoritative evaluator on web and voice", () => {
    expect(cancelRoute).toContain("evaluateLateCancellationPolicy");
    expect(voiceExecutor).toContain("evaluateLateCancellationPolicy");
    expect(voiceExecutor).toContain("buildLateCancellationLockPatch");
    const voiceReschedule = voiceExecutor.slice(
      voiceExecutor.indexOf("async function handleRescheduleBooking"),
      voiceExecutor.indexOf("async function handleJoinWaitlist"),
    );
    expect(voiceReschedule).toContain("self_cancel_fee_enabled");
    expect(voiceReschedule).toContain("self_cancel_window_hours");
    expect(voiceReschedule).toContain("noshow_fee_cents");
    expect(voiceReschedule).toContain('reason: "voice_reschedule"');
  });

  it("requires explicit customer agreement before a voice fee can be charged", () => {
    expect(voiceTools).toContain("late_fee_acknowledged");
    expect(voiceExecutor).toContain("late_fee_confirmation_required");
    expect(voiceExecutor).toContain("late_fee_confirmation_not_verified");
    expect(voiceExecutor).toContain("isExplicitFeeAcknowledgement");
    expect(voiceExecutor).toContain("validateLateFeeChallenge");
    expect(voiceExecutor).toContain("timingSafeEqual");
    expect(voiceTools).toContain("late_fee_confirmation_token");
    expect(voiceExecutor).toContain("!lateFeeAcknowledged");
    expect(voiceExecutor).toContain("amountCentsOverride: feePolicy.feeCents");
  });

  it("fails closed for group cancellation with card charges", () => {
    expect(voiceExecutor).toContain("late_fee_requires_staff");
    expect(voiceExecutor).toContain("Do not cancel it by voice");
  });
});
