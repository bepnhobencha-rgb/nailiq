"use server";

import { revalidatePath } from "next/cache";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import { writeAuditLog } from "@/shared/superadmin/audit";
import {
  parseMultiServiceQaControlInput,
  type MultiServiceQaControlResult,
} from "@/shared/superadmin/multiServiceQaControl";

/**
 * Dedicated dormant control plane for the single disposable Salon QA slot.
 * It is deliberately separate from every generic feature-flag editor. This
 * action is not called by any UI and never enables a tenant by itself.
 */
export async function configureMultiServiceBookingQaSalon(
  rawInput: unknown,
): Promise<MultiServiceQaControlResult> {
  const input = parseMultiServiceQaControlInput(rawInput);
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
    action: "multi_service_qa_rollout_requested",
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
      "configure_multi_service_booking_qa_salon" as never,
      {
        p_salon_id: input.salonId,
        p_enable: input.enable,
        p_confirmation: input.confirmation,
      } as never,
    );
    if (error) {
      if (
        (error as { code?: unknown }).code === "P0001" &&
        String((error as { message?: unknown }).message ?? "").includes(
          "not readiness-complete",
        )
      ) {
        return { ok: false, error: "not_ready" };
      }
      return { ok: false, error: "server_error" };
    }
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
        code === "allowlist_conflict" ||
        code === "salon_not_disposable_qa"
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
