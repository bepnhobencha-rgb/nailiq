import { beforeEach, describe, expect, it, vi } from "vitest";

const { abortSignal, createServiceRoleClient, rpc } = vi.hoisted(() => ({
  abortSignal: vi.fn(),
  createServiceRoleClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient,
}));
vi.mock("server-only", () => ({}));

import { GET } from "./route";

describe("production readiness route", () => {
  beforeEach(() => {
    abortSignal.mockReset();
    createServiceRoleClient.mockReset();
    rpc.mockReset();
    rpc.mockReturnValue({ abortSignal });
    createServiceRoleClient.mockReturnValue({ rpc });
  });

  it("returns ready only when the required database capability responds", async () => {
    abortSignal.mockResolvedValueOnce({
      data: [
        {
          outcome: "job_not_preflightable",
          preflight_id: null,
          preflight_status: null,
          preflight_fingerprint: null,
        },
      ],
      error: null,
    });
    abortSignal.mockResolvedValueOnce({
      data: [{ outcome: "job_not_plannable", plan_id: null }],
      error: null,
    });
    abortSignal.mockResolvedValueOnce({
      data: [{ outcome: "not_found", alert_status: null }],
      error: null,
    });
    abortSignal.mockResolvedValueOnce({
      data: [{ outcome: "unchanged", alert_id: null }],
      error: null,
    });
    abortSignal.mockResolvedValueOnce({
      data: [{ outcome: "not_found", job_status: null }],
      error: null,
    });
    abortSignal.mockResolvedValueOnce({ data: false, error: null });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        database_schema: {
          status: "ok",
          capability: "ai_execution_tenant_fence_v1",
        },
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_ai_campaign_preflight_evidence",
      expect.objectContaining({
        p_job_id: "00000000-0000-0000-0000-000000000001",
        p_salon_id: "00000000-0000-0000-0000-000000000002",
        p_summary: expect.objectContaining({
          manifest_recipient_count: 0,
          eligible_count: 0,
          dispatch_enabled: false,
          no_messages_sent: true,
        }),
        p_decisions: [],
      }),
    );
    expect(rpc).toHaveBeenCalledWith("seal_ai_campaign_dispatch_plan", {
      p_job_id: "00000000-0000-0000-0000-000000000001",
      p_salon_id: "00000000-0000-0000-0000-000000000002",
    });
    expect(rpc).toHaveBeenCalledWith("control_watchdog_alert", {
      p_salon_id: "00000000-0000-0000-0000-000000000002",
      p_alert_id: "00000000-0000-0000-0000-000000000004",
      p_operation: "acknowledge",
      p_actor_user_id: "00000000-0000-0000-0000-000000000005",
      p_resolution_note: null,
    });
    expect(rpc).toHaveBeenCalledWith("record_ai_operational_exception_signal", {
      p_salon_id: "00000000-0000-0000-0000-000000000002",
      p_dedupe_key: "readiness:nonexistent",
      p_source_type: "readiness",
      p_source_ref: "schema_probe",
      p_kind: "readiness_probe",
      p_severity: "info",
      p_title: "Readiness schema probe",
      p_body: null,
      p_signal: "recovered",
      p_evidence: { probe: true, no_write_expected: true },
      p_now: "1970-01-01T00:00:00.000Z",
    });
    expect(rpc).toHaveBeenCalledWith("control_ai_execution_job", {
      p_salon_id: "00000000-0000-0000-0000-000000000002",
      p_job_id: "00000000-0000-0000-0000-000000000001",
      p_operation: "cancel",
      p_actor_user_id: "00000000-0000-0000-0000-000000000005",
    });
    expect(rpc).toHaveBeenCalledWith(
      "ai_tenant_allows_autonomous_execution",
      {
        p_salon_id: "00000000-0000-0000-0000-000000000002",
      },
    );
  });

  it("reports a missing migration without exposing provider details", async () => {
    abortSignal.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "sensitive internal schema cache details",
      },
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        database_schema: {
          status: "error",
          reason: "schema_capability_missing",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("sensitive");
  });

  it("fails closed on an unexpected probe result", async () => {
    abortSignal.mockResolvedValue({ data: "updated", error: null });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      checks: {
        database_schema: { reason: "schema_probe_unexpected" },
      },
    });
  });

  it("fails closed when database configuration or connectivity is absent", async () => {
    createServiceRoleClient.mockImplementation(() => {
      throw new Error("secret provider detail");
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.database_schema.reason).toBe("database_unavailable");
    expect(JSON.stringify(body)).not.toContain("secret provider detail");
  });
});
