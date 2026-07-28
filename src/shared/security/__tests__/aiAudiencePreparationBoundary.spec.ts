import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const service = readFileSync(
  resolve(root, "src/shared/ai/audiencePreparation.ts"),
  "utf8",
);
const action = readFileSync(
  resolve(root, "src/shared/ai/prepareAudienceAction.ts"),
  "utf8",
);
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260728080000_make_ai_audience_preparation_atomic.sql",
  ),
  "utf8",
);

describe("AI audience preparation boundary", () => {
  it("requires owner/admin and binds the service call to the resolved salon", () => {
    expect(action).toContain("getDashboardWriteClient(input.slug)");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain("salonId: ctx.salon.id");
  });

  it("keeps the execution job waiting for separate send authorization", () => {
    expect(service).toContain('job.status !== "waiting_input"');
    expect(service).toContain('"record_ai_audience_preparation" as never');
    expect(service).toContain("no_messages_sent: true");
    expect(migration).toContain("'blocker', 'recipient_selection_required'");
    expect(migration).toContain("and status = 'waiting_input'");
  });

  it("persists the snapshot and audit row atomically and idempotently", () => {
    expect(migration).toContain("for update");
    expect(migration).toContain("return 'unchanged'");
    expect(migration).toContain("update public.ai_execution_jobs");
    expect(migration).toContain("insert into public.ai_actions_log");
    expect(migration).toContain("'execution_audience_prepared'");
    expect(migration).toContain(
      "revoke all on function public.record_ai_audience_preparation",
    );
    expect(migration).toContain("to service_role");
  });

  it("fingerprints both identity and resolved channels", () => {
    expect(service).toContain(
      '`${profile.id}:${decision.sms ? "s" : ""}${decision.email ? "e" : ""}`',
    );
  });

  it("contains no outbound provider dependency", () => {
    expect(service).not.toContain("sendSmsReminder");
    expect(service).not.toContain("getResendClient");
    expect(service).not.toContain("twilio");
    expect(service).not.toContain(".emails.send");
  });
});
