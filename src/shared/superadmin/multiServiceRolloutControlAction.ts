"use server";

import { revalidatePath } from "next/cache";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { writeAuditLog } from "@/shared/superadmin/audit";
import {
  parseMultiServiceRolloutControlInput,
  type MultiServiceRolloutControlResult,
} from "@/shared/superadmin/multiServiceRolloutControl";

/**
 * Dormant, per-salon production rollout control. It is intentionally not wired
 * into a generic feature editor or visible UI. The database atomically rolls
 * back both authorization and salon flag when readiness is incomplete.
 */
export async function configureMultiServiceBookingRollout(
  rawInput: unknown,
): Promise<MultiServiceRolloutControlResult> {
  const input = parseMultiServiceRolloutControlInput(rawInput);
  if (!input) return { ok: false, error: "invalid_payload" };

  const access = await requireActiveSuperAdminSession();
  if (!access.ok) return { ok: false, error: "unauthorized" };
  const { role, user } = access;
  if (role !== "founder" && role !== "ops_admin") {
    return { ok: false, error: "unauthorized" };
  }

  const audited = await writeAuditLog({
    actorUserId: user.id,
    actorRole: role,
    action: "multi_service_production_rollout_requested",
    targetKind: "salon",
    targetId: input.salonId,
    beforeJsonb: null,
    afterJsonb: {
      salon_id: input.salonId,
      enable: input.enable,
      confirmation: input.confirmation,
    },
  });
  if (!audited) return { ok: false, error: "server_error" };

  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "configure_multi_service_booking_rollout" as never,
      {
        p_salon_id: input.salonId,
        p_enable: input.enable,
        p_confirmation: input.confirmation,
        p_actor_user_id: user.id,
      } as never,
    );
    if (error) return { ok: false, error: "server_error" };

    const row = Array.isArray(data) && data.length === 1 ? data[0] : data;
    if (!row || typeof row !== "object") {
      return { ok: false, error: "server_error" };
    }
    const result = row as Record<string, unknown>;
    if (result.success !== true) {
      const code = result.code;
      if (
        code === "not_found" ||
        code === "platform_disabled" ||
        code === "salon_not_active" ||
        code === "not_ready"
      ) {
        return { ok: false, error: code };
      }
      return { ok: false, error: "server_error" };
    }

    const expectedCode = input.enable ? "enabled" : "disabled";
    if (result.code !== expectedCode || result.salon_id !== input.salonId) {
      return { ok: false, error: "server_error" };
    }
    revalidatePath(`/superadmin/salons/${input.salonId}`);
    revalidatePath("/superadmin/salons");
    return { ok: true, salonId: input.salonId, enabled: input.enable };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
