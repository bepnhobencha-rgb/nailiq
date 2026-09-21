"use server";

import { z } from "zod";
import { requireActiveSuperAdminSession } from "@/shared/auth/requireActiveSuperAdminSession";
import { runDigestBackfill } from "@/shared/ai/digestBackfill";
import { writeAuditLog } from "@/shared/superadmin/audit";
import { SUPERADMIN_OPERATORS } from "@/shared/superadmin/permissions";

const inputSchema = z.object({
  salonId: z.uuid(),
  reportDate: z.iso.date(),
  mode: z.enum(["check", "send"]),
  confirmed: z.boolean(),
  expectedRecipientCount: z.number().int().min(1).max(50).optional(),
}).strict();

/** No client-supplied recipient, template, provider key or arbitrary cron job. */
export async function recoverSalonDigest(input: unknown) {
  const access = await requireActiveSuperAdminSession();
  if (!access.ok) return { ok: false as const, error: "unauthorized" as const };
  if (!SUPERADMIN_OPERATORS.includes(access.role)) {
    return { ok: false as const, error: "forbidden" as const };
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || (parsed.data.mode === "send" &&
    (!parsed.data.confirmed || !parsed.data.expectedRecipientCount))) {
    return { ok: false as const, error: "invalid_input" as const };
  }
  const { salonId, reportDate, mode, expectedRecipientCount } = parsed.data;
  // Platform authority alone must not bypass the target salon's membership.
  const { data: member, error } = await access.supabase.from("salon_members")
    .select("role").eq("salon_id", salonId).eq("user_id", access.user.id).maybeSingle();
  if (error || !member) return { ok: false as const, error: "unauthorized" as const };
  if (!["owner", "admin"].includes(member.role)) {
    return { ok: false as const, error: "forbidden" as const };
  }
  try {
    const check = await runDigestBackfill({ salonId, reportDate }, { dryRun: true });
    if (mode === "check" || check.status !== "ready") return { ok: true as const, result: check };
    if (check.recipientCount !== expectedRecipientCount) {
      return { ok: false as const, error: "recipients_changed" as const };
    }
    const audited = await writeAuditLog({
      actorUserId: access.user.id,
      actorRole: access.role,
      action: "digest_backfill_requested",
      targetKind: "salon",
      targetId: salonId,
      afterJsonb: { reportDate, recipientCount: check.recipientCount },
      reason: "Operator confirmed recovery to existing configured digest recipients",
    });
    if (!audited) return { ok: false as const, error: "audit_failed" as const };
    const result = await runDigestBackfill({ salonId, reportDate }, { expectedRecipientCount });
    return { ok: true as const, result };
  } catch {
    // Never return raw provider/DB errors, contact information or report data.
    return { ok: false as const, error: "verification_required" as const };
  }
}
