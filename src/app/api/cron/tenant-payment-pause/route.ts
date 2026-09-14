import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function GET(request: NextRequest) {
  const authorizationError = requireCronAuthorization(request);
  if (authorizationError) return authorizationError;

  return runTrackedCron("tenant_payment_pause", async () => {
    const db = createServiceRoleClient();
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("salons")
      .select("id, payment_grace_ends_at" as never)
      .eq("subscription_status", "past_due")
      .is("archived_at", null)
      .not("payment_grace_ends_at", "is", null)
      .lte("payment_grace_ends_at", now)
      .limit(100);

    if (error || !Array.isArray(data)) {
      console.error("[tenant-payment-pause] query failed");
      return NextResponse.json({ ok: false, error: "query_failed" }, { status: 500 });
    }

    let paused = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const raw of data ?? []) {
      const row = record(raw);
      const id = row?.id;
      const deadline = row?.payment_grace_ends_at;
      if (typeof id !== "string" || !UUID.test(id) ||
          typeof deadline !== "string" || !Number.isFinite(Date.parse(deadline))) {
        failed.push(typeof id === "string" && UUID.test(id) ? id : "invalid_row");
        continue;
      }

      try {
        // Discovery can become stale while another request confirms payment or
        // extends grace. Only the database may authorize this exact pause.
        const { data: receipt, error: pauseError } = await db.rpc(
          "pause_tenant_if_payment_grace_expired",
          { p_salon_id: id, p_expected_deadline: deadline },
        );
        const result = record(receipt);
        if (!pauseError && result?.ok === true && result.salon_id === id &&
            result.code === "paused" && typeof result.audit_id === "string" &&
            UUID.test(result.audit_id)) {
          paused += 1;
        } else if (!pauseError && result?.ok === true && result.salon_id === id &&
                   result.code === "skipped_not_eligible") {
          skipped += 1;
        } else {
          failed.push(id);
        }
      } catch {
        // Missing RPC or response loss must never fall back to an unfenced
        // update. The next run safely rechecks current database state.
        failed.push(id);
      }
    }

    return NextResponse.json(
      { ok: failed.length === 0, eligible: data?.length ?? 0, paused, skipped, failed },
      { status: failed.length === 0 ? 200 : 503 },
    );
  });
}
