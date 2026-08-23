/**
 * Dedicated cron for syncing EMAIL-only marketing consent from Square.
 *
 * This paginates through ALL Square customers per salon (thousands), which is
 * far too heavy to bolt onto the every-5-min square-sync cron (60s budget) — it
 * timed that out. It lives here on its own daily schedule with a long budget.
 *
 * Gated OFF by default (SQUARE_EMAIL_CONSENT_SYNC). Import-only: it stamps/clears
 * client_profiles.marketing_email_consent_at; it never sends anything. Sending is
 * separately gated by SQUARE_EMAIL_CONSENT_SEND in the AI agents.
 */
import { NextRequest, NextResponse } from "next/server";
import { looseServiceClient } from "@/shared/integrations/square/looseDb";
import { syncSquareEmailConsent } from "@/shared/integrations/square/emailConsentSync";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("square_email_consent", async () => {
    if (process.env.SQUARE_EMAIL_CONSENT_SYNC !== "1") {
      return NextResponse.json({ ok: true, skipped: "disabled" });
    }

    const supabase = looseServiceClient();
    const { data: integrations, error } = await supabase
      .from("square_integrations")
      .select("salon_id")
      .eq("enabled", true)
      .not("access_token", "is", null);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "square_email_consent_integrations_unavailable" },
        { status: 500 },
      );
    }

    let failed = false;
    const results: Record<string, unknown> = {};
    for (const it of integrations ?? []) {
      const salonId = it.salon_id as string;
      try {
        const result = await syncSquareEmailConsent(salonId);
        if (!result.ok) {
          failed = true;
          results[salonId] = {
            ok: false,
            squareCustomers: result.squareCustomers,
            granted: result.granted,
            revoked: result.revoked,
            error: "square_email_consent_sync_failed",
          };
        } else {
          results[salonId] = result;
        }
      } catch {
        failed = true;
        results[salonId] = {
          ok: false,
          error: "square_email_consent_sync_failed",
        };
      }
    }

    return NextResponse.json(
      { ok: !failed, results },
      failed ? { status: 500 } : undefined,
    );
  });
}
