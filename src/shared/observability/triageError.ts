import Anthropic from "@anthropic-ai/sdk";
import { createTextBackgroundAnthropicClient } from "@/shared/ai/anthropicProviderPolicy";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import {
  assessErrorEvidence,
  evidenceConflictSummary,
} from "@/shared/observability/errorEvidence";

/**
 * Phase 2 — the "smart" layer. Claude triages a captured error into a
 * plain-language summary + a concrete suggested fix, written back to
 * error_logs.ai_summary / ai_suggested_fix. Then (for new error/fatal rows)
 * an alert email goes to the operator so we fix it before customers complain.
 * Cheap (Haiku, ~$0.0003/error) and graceful — no API key ⇒ deterministic
 * fallback summary, never throws.
 */

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = createTextBackgroundAnthropicClient(key);
  return anthropicClient;
}

type ErrRow = {
  id: string;
  level: string;
  message: string;
  surface: string | null;
  route: string | null;
  stack: string | null;
  context: Record<string, unknown> | null;
};

export async function triageError(
  id: string,
): Promise<{ ok: boolean; blocked?: "evidence_conflict" }> {
  try {
    const db = createServiceRoleClient();
    const { data } = await db
      .from("error_logs")
      .select("id, level, message, surface, route, stack, context")
      .eq("id", id)
      .maybeSingle();
    const e = data as ErrRow | null;
    if (!e) return { ok: false };

    const evidence = assessErrorEvidence(e.route, e.context);
    if (evidence.status === "conflict") {
      await db
        .from("error_logs")
        .update({
          ai_summary: evidenceConflictSummary(evidence),
          ai_suggested_fix:
            "Wait for a new route-scoped occurrence before triage or code changes.",
        } as never)
        .eq("id", id);
      return { ok: false, blocked: "evidence_conflict" };
    }

    const client = getClient();
    let summary: string;
    let fix: string | null = null;

    if (!client) {
      // Deterministic fallback when no AI key — still useful at a glance.
      summary = `${e.level} on ${e.surface ?? "app"}${e.route ? ` at ${e.route}` : ""}: ${e.message.slice(0, 120)}`;
    } else {
      const prompt = `You triage runtime errors for a salon-booking SaaS (Next.js 16 + Supabase + Prisma). Given ONE error, reply with ONLY a JSON object, no prose:
{"summary":"one plain-English sentence: what is failing and the most likely cause","suggested_fix":"one concrete next step or the file/area to check"}

Error:
level: ${e.level}
surface: ${e.surface ?? ""}
route: ${e.route ?? ""}
message: ${e.message}
stack: ${(e.stack ?? "").slice(0, 1500)}
context: ${JSON.stringify(e.context ?? {}).slice(0, 500)}`;

      const resp = await trackAnthropicMessage(
        {
          salonId: null,
          feature: "error_triage",
          model: "claude-haiku-4-5",
        },
        () => client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 320,
          messages: [{ role: "user", content: prompt }],
        }),
      );
      const text =
        resp.content?.find((b) => b.type === "text")?.type === "text"
          ? (resp.content.find((b) => b.type === "text") as { text: string }).text
          : "";
      try {
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        summary = String(json.summary ?? "").slice(0, 500) || `${e.level}: ${e.message.slice(0, 120)}`;
        fix = json.suggested_fix ? String(json.suggested_fix).slice(0, 500) : null;
      } catch {
        summary = `${e.level}: ${e.message.slice(0, 200)}`;
      }
    }

    await db
      .from("error_logs")
      .update({
        ai_summary: summary,
        ai_suggested_fix: fix,
        remediation_state: "triaged",
      } as never)
      .eq("id", id)
      .eq("remediation_state" as never, "detected");
    return { ok: true };
  } catch (err) {
    console.error("[triageError]", err);
    return { ok: false };
  }
}

/** Email the operator about a new error (after triage, so the AI summary is in). */
export async function sendErrorAlert(id: string): Promise<boolean> {
  try {
    const db = createServiceRoleClient();
    const { data } = await db
      .from("error_logs")
      .select("level, message, surface, route, occurrence_count, ai_summary, ai_suggested_fix")
      .eq("id", id)
      .maybeSingle();
    const e = data as {
      level: string;
      message: string;
      surface: string | null;
      route: string | null;
      occurrence_count: number;
      ai_summary: string | null;
      ai_suggested_fix: string | null;
    } | null;
    if (!e) return false;

    const { data: ps } = await db
      .from("platform_settings")
      .select("error_alert_email")
      .eq("id", "platform")
      .maybeSingle();
    const to =
      ((ps as { error_alert_email?: string | null } | null)?.error_alert_email ?? "").trim() ||
      (process.env.ERROR_ALERT_EMAIL ?? "").trim();
    if (!to) return false;

    const resend = getResendClient();
    if (!resend) return false;

    const site = (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "");
    const link = `${site}/superadmin/operations/system-health`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px">
        <p style="font-size:18px;margin:0 0 4px">🚨 New ${e.level} in NailIQ</p>
        <p style="color:#555;margin:0 0 16px">Seen ${e.occurrence_count}× · ${e.surface ?? "app"}${e.route ? ` · ${e.route}` : ""}</p>
        <p style="background:#f6f6f6;padding:12px;border-radius:8px;font-family:monospace;font-size:13px;margin:0 0 12px">${escapeHtml(e.message).slice(0, 400)}</p>
        ${e.ai_summary ? `<p style="margin:0 0 8px"><b>🧠 Summary:</b> ${escapeHtml(e.ai_summary)}</p>` : ""}
        ${e.ai_suggested_fix ? `<p style="margin:0 0 16px"><b>Suggested fix:</b> ${escapeHtml(e.ai_suggested_fix)}</p>` : ""}
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open error monitor</a>
      </div>`;

    const { error } = await resend.emails.send({
      from: getResendFrom(),
      to,
      subject: `🚨 NailIQ ${e.level}: ${e.message.slice(0, 80)}`,
      html,
    });
    return !error;
  } catch (err) {
    console.error("[sendErrorAlert]", err);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
}
