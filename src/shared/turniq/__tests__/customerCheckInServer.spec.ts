import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

import {
  issueTurnIqCustomerCheckInCapability,
  recordTurnIqCustomerCheckInShadow,
} from "@/shared/turniq/customerCheckInServer";

const TOKEN = "99999999-9999-4999-8999-999999999999";
const INPUT = {
  commandId: "11111111-1111-4111-8111-111111111111",
  channel: "qr" as const,
  visitKind: "booked" as const,
  serviceId: "22222222-2222-4222-8222-222222222222",
  partySize: 1,
  submittedAt: "2026-09-02T18:00:00.000Z",
  actorSessionFingerprint: "a".repeat(64),
  requestedTechnician: null,
};

describe("TurnIQ M4M customer check-in server boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records only the deterministic receipt through the service-role RPC", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        replayed: false,
        status: "shadow_received",
        next_route: "single_engine_candidate",
        intake_fingerprint: expect.anything(),
      },
      error: null,
    });
    // Match the server-generated fingerprint without weakening the response
    // validation under test.
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
      data: {
        ok: true,
        replayed: false,
        status: "shadow_received",
        next_route: "single_engine_candidate",
        intake_fingerprint: args.p_intake_fingerprint,
      },
      error: null,
    }));

    const result = await recordTurnIqCustomerCheckInShadow(TOKEN, INPUT);
    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      status: "shadow_received",
      nextRoute: "single_engine_candidate",
    });
    expect(rpc).toHaveBeenCalledWith(
      "record_turniq_customer_checkin_shadow_v1",
      expect.objectContaining({
        p_channel: "qr",
        p_visit_kind: "booked",
        p_command_id: INPUT.commandId,
        p_service_id: INPUT.serviceId,
        p_party_size: 1,
        p_requested_staff_id: null,
      }),
    );
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_capability_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_capability_token_hash).not.toBe(TOKEN);
    expect(JSON.stringify(args)).not.toMatch(/phone|email|customerName/i);
  });

  it("returns the same committed truth for an RPC replay", async () => {
    rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
      data: {
        ok: true,
        replayed: true,
        status: "shadow_received",
        next_route: "single_engine_candidate",
        intake_fingerprint: args.p_intake_fingerprint,
      },
      error: null,
    }));
    await expect(recordTurnIqCustomerCheckInShadow(TOKEN, INPUT))
      .resolves.toMatchObject({ ok: true, replayed: true });
  });

  it("rejects malformed public material before constructing a database call", async () => {
    await expect(recordTurnIqCustomerCheckInShadow("raw-secret", INPUT))
      .resolves.toEqual({ ok: false, code: "invalid_capability" });
    await expect(recordTurnIqCustomerCheckInShadow(TOKEN, { ...INPUT, partySize: 99 }))
      .resolves.toEqual({ ok: false, code: "invalid_request" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when SQL truth does not match the deterministic receipt", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        replayed: false,
        status: "shadow_received",
        next_route: "identity_match_required",
        intake_fingerprint: "b".repeat(64),
      },
      error: null,
    });
    await expect(recordTurnIqCustomerCheckInShadow(TOKEN, INPUT))
      .resolves.toEqual({ ok: false, code: "temporarily_unavailable" });
  });

  it("mints an opaque token while persisting only its hash", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        capability_id: "77777777-7777-4777-8777-777777777777",
        expires_at: "2026-09-02T20:00:00.000Z",
        max_uses: 1,
      },
      error: null,
    });
    const result = await issueTurnIqCustomerCheckInCapability({
      salonId: "33333333-3333-4333-8333-333333333333",
      bookingId: "44444444-4444-4444-8444-444444444444",
      serviceId: INPUT.serviceId,
      channel: "qr",
      visitKind: "booked",
      expiresAt: "2026-09-02T20:00:00.000Z",
      maxUses: 1,
      actorUserId: "55555555-5555-4555-8555-555555555555",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toMatch(/^[0-9a-f-]{36}$/);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_token_hash).not.toContain(result.token);
  });
});
