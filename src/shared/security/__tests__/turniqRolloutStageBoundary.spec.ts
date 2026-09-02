import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260902224942_add_turniq_rollout_stages.sql",
  ),
  "utf8",
);
const actionCore = readFileSync(
  resolve(process.cwd(), "src/shared/turniq/actionCore.ts"),
  "utf8",
);
const integrityHotfix = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260902225251_harden_turniq_rollout_event_integrity.sql",
  ),
  "utf8",
);
const idempotencyHotfix = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260902225916_harden_turniq_rollout_command_idempotency.sql",
  ),
  "utf8",
);
const offlineServer = readFileSync(
  resolve(process.cwd(), "src/shared/turniq/offlineServer.ts"),
  "utf8",
);

describe("TurnIQ rollout stage boundary", () => {
  it("creates a default-off four-stage state machine without enabling a salon", () => {
    expect(migration).toContain("DEFAULT 'off'");
    expect(migration).toContain("'off', 'shadow', 'supervised', 'live'");
    expect(migration).not.toMatch(/UPDATE public\.platform_flags/i);
    expect(migration).not.toMatch(/UPDATE public\.salons[\s\S]*feature_flags/i);
  });

  it("keeps direct state private and transitions service-role-only", () => {
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE public\.turniq_rollout_controls[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.configure_turniq_rollout_stage_v1\([\s\S]*TO service_role/i,
    );
    expect(migration).toContain("p_actor_role NOT IN ('owner', 'admin')");
    expect(migration).toContain("stage_skip_forbidden");
  });

  it("records immutable idempotent transition receipts", () => {
    expect(migration).toContain("UNIQUE (salon_id, command_id)");
    expect(migration).toContain("UNIQUE (salon_id, state_version)");
    expect(migration).toContain("idempotency_conflict");
    expect(idempotencyHotfix).toContain(
      "v_existing_fingerprint IS DISTINCT FROM p_request_fingerprint",
    );
    expect(migration).toContain("request_fingerprint");
    expect(migration).toContain("from_stage");
    expect(migration).toContain("to_stage");
    expect(integrityHotfix).toContain("BEFORE UPDATE OR DELETE");
    expect(integrityHotfix).toContain("TurnIQ rollout events are append-only");
    expect(integrityHotfix).toContain("reason IS NOT NULL");
  });

  it("blocks online mutation below supervised and offline mutation below live", () => {
    expect(actionCore).toContain("turnIqStageAllowsOnlineMutation");
    expect(actionCore).toContain('failure("rollout_stage_blocked")');
    expect(offlineServer).toContain("turnIqStageAllowsOfflineMutation");
    expect(offlineServer).toContain('code: "rollout_stage_blocked"');
  });

  it("contains no provider or notification dispatch", () => {
    expect(migration).not.toMatch(/twilio|resend|square|stripe|notification_outbox/i);
  });
});
