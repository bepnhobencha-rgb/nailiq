import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260728070000_surface_strategist_operational_note.sql",
);
const manager = read("src/app/api/cron/manager/route.ts");
const producer = read(
  "src/shared/ai/strategistOperationalNoteApproval.ts",
);

describe("strategist operational-note approval boundary", () => {
  it("surfaces only recent, real structural strategist activity", () => {
    expect(migration).toContain("agent = 'strategist'");
    expect(migration).toContain("action_type = 'escalate_structural'");
    expect(migration).toContain("created_at >= p_now - interval '14 days'");
    expect(migration).toContain("created_at <= p_now");
    expect(migration).toContain("'record_operational_note'");
  });

  it("deduplicates permanently by source across retries and overlaps", () => {
    expect(migration).toContain(
      "approval_requests_source_action_once_idx",
    );
    expect(migration).toContain("on conflict (source_action_id)");
    expect(migration).not.toContain("on delete set null");
    expect(migration).toContain("'status', 'existing'");
  });

  it("creates only an expiring owner decision and never executes it", () => {
    expect(migration).toContain("'pending'");
    expect(migration).toContain("p_now + interval '7 days'");
    expect(migration).not.toMatch(
      /insert into public\.ai_execution_jobs|execute_ai_operational_note|sendSms|sendEmail|charge|refund|update public\.bookings|auth\./,
    );
    expect(manager).toContain("surfaceStrategistOperationalNoteApproval");
    expect(manager).toContain('entry.strategist_note = "failed"');
    expect(producer).toContain("createServiceRoleClient");
  });

  it("keeps the producer RPC service-role-only", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toMatch(
      /revoke all on function public\.surface_strategist_operational_note_approval\([\s\S]*?from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.surface_strategist_operational_note_approval\([\s\S]*?to service_role/,
    );
  });
});
