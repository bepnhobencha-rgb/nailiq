"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { runApprovedCancellationFeePayment } from "@/shared/payments/executeBookingPaymentOperation";
import { allowsApprovedCancellationFeeDispatch } from "@/shared/release/v1IntegrationScope";

export async function dispatchApprovedCancellationFee(
  slug: string,
  input: {
    salonId: string;
    reviewId: string;
    reviewKind: "late" | "group";
  },
): Promise<
  { ok: true; code: "charge_succeeded"; paymentStatus: "succeeded" } |
  { ok: false; error: string }
> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role) || !ctx.userId) {
    return { ok: false, error: "unauthorized" };
  }
  if (ctx.salon.id !== input.salonId) {
    return { ok: false, error: "salon_mismatch" };
  }
  if (!allowsApprovedCancellationFeeDispatch()) {
    return { ok: false, error: "dispatch_release_disabled" };
  }
  const provider = await resolvePaymentProvider(ctx.salon.id, {
    strict: true,
    purpose: "approved_cancellation_fee",
  }).catch(() => null);
  if (!provider) {
    return { ok: false, error: "provider_configuration_unavailable" };
  }
  const db = createServiceRoleClient();
  const outcome = await runApprovedCancellationFeePayment({
    db: {
      rpc: async (name, args) => {
        const result = await db.rpc(name as never, args as never);
        return { data: result.data, error: result.error };
      },
    },
    salonId: ctx.salon.id,
    reviewId: input.reviewId,
    reviewKind: input.reviewKind,
    actorUserId: ctx.userId,
    actorRole: ctx.role === "owner" ? "owner" : "admin",
    provider,
  });
  return outcome.ok
    ? { ok: true, code: "charge_succeeded", paymentStatus: "succeeded" }
    : { ok: false, error: outcome.reason };
}
