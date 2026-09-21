"use server";
import type { recoverSalonDigest as RealAction } from "@/shared/superadmin/digestBackfillActions";
// Passed ONLY by this isolated fixture. No runtime DB/provider imports.
export async function recoverSalonDigest(raw: unknown): Promise<Awaited<ReturnType<typeof RealAction>>> {
  const input = raw as { reportDate: string; mode: string };
  if (input.reportDate === "2026-09-19") return { ok: false, error: "verification_required" };
  if (input.mode === "check") return { ok: true, result: { status: "ready", reportDate: input.reportDate, recipientCount: 2 } };
  return { ok: true, result: { status: "sent", reportDate: input.reportDate, recipientCount: 2, providerMessageId: "synthetic-no-provider" } };
}
