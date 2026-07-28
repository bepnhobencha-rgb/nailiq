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
    abortSignal.mockResolvedValue({
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

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        database_schema: {
          status: "ok",
          capability: "record_ai_campaign_dispatch_preflight_v1",
        },
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_ai_campaign_dispatch_preflight",
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
