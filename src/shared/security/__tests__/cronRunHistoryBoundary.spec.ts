import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const trackedRoutes = {
  "campaign-scheduler": "campaign_scheduler",
  "close-stale-in-progress": "close_stale_in_progress",
  "deposit-compensation": "deposit_compensation",
  "error-triage": "error_triage",
  "minh-learn": "minh_learn",
  "nail-tryon-cleanup": "nail_tryon_cleanup",
  "noshow-card-nudge": "noshow_card_nudge",
  "noshow-charge-retry": "noshow_charge_retry",
  "payment-reconciliation": "payment_reconciliation",
  reminders: "reminders",
  "send-pending-notifications": "send_pending_notifications",
  "spend-sync": "spend_sync",
  "square-email-consent": "square_email_consent",
  "square-sync": "square_sync",
  "waitlist-advance": "waitlist_advance",
  "wix-sync": "wix_sync",
} as const;

describe("cron run history boundary", () => {
  const migration = read(
    "supabase/migrations/20260728142000_track_all_cron_runs.sql",
  );
  const paymentWorkerMigration = read(
    "supabase/migrations/20260823021144_extend_cron_worker_allowlist_for_payment_workers.sql",
  );

  it("tracks every non-AI cron only after centralized authorization", () => {
    for (const [routeName, workerName] of Object.entries(trackedRoutes)) {
      const source = read(`src/app/api/cron/${routeName}/route.ts`);
      const authorizationAt = source.indexOf(
        "requireCronAuthorization(",
        source.indexOf("export async function GET"),
      );
      const trackingAt = source.indexOf(`runTrackedCron("${workerName}"`);

      expect(authorizationAt, `${routeName} must authorize`).toBeGreaterThan(-1);
      expect(trackingAt, `${routeName} must track its run`).toBeGreaterThan(-1);
      expect(authorizationAt, `${routeName} must authorize first`).toBeLessThan(
        trackingAt,
      );
      expect(source.match(/runTrackedCron\(/g)).toHaveLength(1);
    }
  });

  it("retains the two specialized AI heartbeat implementations", () => {
    const execution = read("src/app/api/cron/ai-execution/route.ts");
    const manager = read("src/app/api/cron/manager/route.ts");

    expect(execution).toContain("recordExecutionWorkerHeartbeat");
    expect(manager).toContain("recordAiWorkerHeartbeat");
    expect(execution).not.toContain("runTrackedCron");
    expect(manager).not.toContain("runTrackedCron");
  });

  it("uses one fixed allowlist across state, history, and the writer", () => {
    for (const workerName of [
      "ai_execution",
      "ai_manager",
      ...Object.values(trackedRoutes),
    ]) {
      const allowlistSource = [
        "deposit_compensation",
        "payment_reconciliation",
      ].includes(workerName)
        ? paymentWorkerMigration
        : migration;
      expect(
        allowlistSource.match(new RegExp(`'${workerName}'`, "g"))?.length,
      ).toBe(3);
    }
    expect(migration).toContain(
      "if not public.ai_cron_worker_supported(p_worker_name)",
    );
  });

  it("keeps both tables and capability service-role-only", () => {
    expect(migration).toMatch(
      /revoke all on function public\.ai_cron_worker_supported\(text\)[\s\S]+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.ai_cron_worker_supported\(text\)[\s\S]+to service_role/,
    );
    expect(migration).not.toMatch(/grant .* to anon|grant .* to authenticated/);
  });
});
