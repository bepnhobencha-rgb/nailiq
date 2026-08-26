import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  parseBookingPaymentOperationMaterial,
  parseClaimedBookingPaymentOperation,
} from "@/shared/payments/bookingPaymentOperations";
import { dispatchClaimedBookingPaymentOperation } from "@/shared/payments/executeBookingPaymentOperation";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}

export async function GET(request: NextRequest) {
  const authorizationError = requireCronAuthorization(request);
  if (authorizationError) return authorizationError;
  if (process.env.PAYMENT_LEDGER_WORKERS_ENABLED !== "true") {
    return NextResponse.json({ ok: true, code: "disabled", processed: 0 });
  }
  return runTrackedCron("deposit_compensation", async () => {
    const db = createServiceRoleClient();
    let discovered: { data: unknown; error: unknown };
    try {
      discovered = await db.rpc("discover_due_unbound_deposit_compensations", {
        p_limit: 25,
      });
    } catch {
      return NextResponse.json({ ok: false, code: "discovery_unavailable" }, { status: 503 });
    }
    if (discovered.error || !Array.isArray(discovered.data)) {
      return NextResponse.json({ ok: false, code: "discovery_unavailable" }, { status: 503 });
    }

    let processed = 0;
    let refunded = 0;
    let unresolved = 0;
    for (const candidate of discovered.data) {
      const due = row(candidate);
      const parentOperationId = typeof due?.parent_operation_id === "string"
        ? due.parent_operation_id
        : "";
      const leaseToken = typeof due?.lease_token === "string" ? due.lease_token : "";
      const fingerprint = typeof due?.material_fingerprint === "string"
        ? due.material_fingerprint
        : "";
      const material = parseBookingPaymentOperationMaterial(
        { ...(due?.material as Record<string, unknown> | null ?? {}), material_fingerprint: fingerprint },
        "deposit_refund",
      );
      if (!parentOperationId || !leaseToken || !material || material.bookingId !== null) {
        unresolved += 1;
        continue;
      }
      processed += 1;
      let claimed: { data: unknown; error: unknown };
      try {
        claimed = await db.rpc("claim_due_unbound_deposit_refund", {
          p_parent_operation_id: parentOperationId,
          p_lease_token: leaseToken,
          p_expected_material_fingerprint: material.materialFingerprint,
        });
      } catch {
        unresolved += 1;
        continue;
      }
      if (claimed.error) {
        unresolved += 1;
        continue;
      }
      const claim = parseClaimedBookingPaymentOperation(claimed.data, "deposit_refund");
      if (!claim) {
        const claimedRow = row(claimed.data);
        if (claimedRow?.success === true && claimedRow.status === "succeeded") refunded += 1;
        else unresolved += 1;
        continue;
      }
      const outcome = await dispatchClaimedBookingPaymentOperation({
        db: db as never,
        claim,
        reason: "Automatic refund — booking deposit was not bound",
      });
      if (outcome.ok) refunded += 1;
      else unresolved += 1;
    }
    return NextResponse.json(
      {
        ok: unresolved === 0,
        ...(unresolved === 0 ? {} : { code: "compensation_incomplete" }),
        processed,
        refunded,
        unresolved,
      },
      { status: unresolved === 0 ? 200 : 503 },
    );
  });
}
