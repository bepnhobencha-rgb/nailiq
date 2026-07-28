import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const service = readFileSync(
  resolve(root, "src/shared/ai/campaignDispatchPreflight.ts"),
  "utf8",
);
const action = readFileSync(
  resolve(root, "src/shared/ai/preflightCampaignAction.ts"),
  "utf8",
);
const migration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260728094127_add_campaign_dispatch_preflight.sql",
  ),
  "utf8",
);
const freshnessMigration = readFileSync(
  resolve(
    root,
    "supabase/migrations/20260728101931_add_campaign_preflight_freshness.sql",
  ),
  "utf8",
);

describe("AI campaign dispatch preflight boundary", () => {
  it("authorizes only owner/admin dashboard writes", () => {
    expect(action).toContain("getDashboardWriteClient");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain('error: "forbidden"');
  });

  it("is service-role-only, RLS-protected and append-only", () => {
    expect(migration).toContain(
      "alter table public.ai_campaign_dispatch_preflights enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.ai_campaign_dispatch_preflights",
    );
    expect(migration).toContain("for all to service_role");
    expect(migration).toContain(
      "create trigger ai_campaign_dispatch_preflights_immutable",
    );
    expect(migration).toContain(
      "revoke all on function public.record_ai_campaign_dispatch_preflight",
    );
    expect(migration).toContain(
      ") from public, anon, authenticated",
    );
    expect(migration).toContain("security invoker");
  });

  it("recomputes evidence and forbids channel expansion", () => {
    expect(migration).toContain("v_fingerprint <> p_summary ->>");
    expect(migration).toContain("v_decision_count <> v_unique_count");
    expect(migration).toContain(
      "(item ->> 'sms')::boolean and not mr.sms",
    );
    expect(migration).toContain(
      "(item ->> 'email')::boolean and not mr.email",
    );
  });

  it("keeps dispatch locked and has no outbound provider dependency", () => {
    expect(service).toContain(
      '"record_ai_campaign_preflight_evidence" as never',
    );
    expect(service).toContain("dispatch_enabled !== false");
    expect(service).not.toMatch(/twilio|resend/i);
    expect(migration).toContain("'blocker', 'dispatch_not_enabled'");
    expect(migration).toContain("'dispatch_enabled', false");
    expect(migration).toContain("'no_messages_sent', true");
  });

  it("expires point-in-time evidence and refreshes it idempotently", () => {
    expect(freshnessMigration).toContain("add column valid_until");
    expect(freshnessMigration).toContain("interval '5 minutes'");
    expect(freshnessMigration).toContain(
      "record_ai_campaign_dispatch_preflight_fresh",
    );
    expect(freshnessMigration).toContain("order by candidate.created_at desc");
    expect(freshnessMigration).toContain("v_outcome := 'refreshed'");
    expect(freshnessMigration).toContain("'dispatch_enabled', false");
    expect(freshnessMigration).toContain("'no_messages_sent', true");
    expect(freshnessMigration).toContain(
      ") from public, anon, authenticated",
    );
  });
});
