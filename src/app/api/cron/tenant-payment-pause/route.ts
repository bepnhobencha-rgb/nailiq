import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";
import { pauseTenant } from "@/shared/subscriptions/tenantPause";
import { writeAuditLog } from "@/shared/superadmin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

export async function GET(request: NextRequest) {
  const authorizationError = requireCronAuthorization(request);
  if (authorizationError) return authorizationError;

  return runTrackedCron("tenant_payment_pause", async () => {
    const db = createServiceRoleClient();
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("salons")
      .select("id, slug, subscription_status, payment_grace_ends_at" as never)
      .eq("subscription_status", "past_due")
      .is("archived_at", null)
      .not("payment_grace_ends_at", "is", null)
      .lte("payment_grace_ends_at", now)
      .limit(100);

    if (error) {
      console.error("[tenant-payment-pause] query", error);
      return NextResponse.json({ ok: false, error: "query_failed" }, { status: 500 });
    }

    let paused = 0;
    const failed: string[] = [];
    for (const raw of data ?? []) {
      const row = raw as unknown as { id: string; slug: string; payment_grace_ends_at: string };
      const audited = await writeAuditLog({
        actorUserId: null,
        actorRole: "system",
        action: "tenant_pause_non_payment",
        targetKind: "salon",
        targetId: row.id,
        beforeJsonb: { subscription_status: "past_due", payment_grace_ends_at: row.payment_grace_ends_at },
        afterJsonb: { archived: true, reason: "non_payment", wixSquareChanged: false },
        reason: "Payment grace period expired",
      });
      if (!audited) {
        failed.push(row.id);
        continue;
      }
      const result = await pauseTenant(db, {
        salonId: row.id,
        reason: "non_payment",
        note: "Payment grace period expired",
      });
      if (result.ok) paused += 1;
      else failed.push(row.id);
    }

    return NextResponse.json({ ok: failed.length === 0, eligible: data?.length ?? 0, paused, failed });
  });
}
