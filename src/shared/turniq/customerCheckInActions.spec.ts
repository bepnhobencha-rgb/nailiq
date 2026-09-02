import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  visible: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  booking: vi.fn(),
  stage: vi.fn(),
}));

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.context,
}));
vi.mock("@/shared/features/platformFeatureFlags", () => ({
  isReleaseFeatureVisible: mocks.visible,
}));
vi.mock("@/shared/turniq/customerCheckInServer", () => ({
  issueTurnIqCustomerCheckInCapability: mocks.issue,
  revokeTurnIqCustomerCheckInCapability: mocks.revoke,
}));
vi.mock("@/shared/turniq/serverDal", () => ({
  loadTurnIqRolloutStage: mocks.stage,
}));

import {
  issueTurnIqCustomerCheckInLink,
  revokeTurnIqCustomerCheckInLink,
} from "./customerCheckInActions";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "33333333-3333-4333-8333-333333333333";
const SERVICE_ID = "44444444-4444-4444-8444-444444444444";
const CAPABILITY_ID = "55555555-5555-4555-8555-555555555555";
const TOKEN = "66666666-6666-4666-8666-666666666666";

function bookingQuery() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "in"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = mocks.booking;
  return chain;
}

describe("TurnIQ customer check-in link actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.visible.mockResolvedValue(true);
    mocks.stage.mockResolvedValue("supervised");
    mocks.booking.mockResolvedValue({
      data: {
        id: BOOKING_ID,
        service_id: SERVICE_ID,
        party_size: 2,
        start_time_utc: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      },
      error: null,
    });
    mocks.context.mockResolvedValue({
      salon: { id: SALON_ID, slug: "qa-salon", feature_flags: {} },
      kind: "member",
      role: "receptionist",
      userId: USER_ID,
      supabase: { from: vi.fn(() => bookingQuery()) },
    });
    mocks.issue.mockResolvedValue({
      ok: true,
      capabilityId: CAPABILITY_ID,
      token: TOKEN,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      maxUses: 1,
    });
    mocks.revoke.mockResolvedValue({
      ok: true,
      capabilityId: CAPABILITY_ID,
      revokedAt: new Date().toISOString(),
      replayed: false,
    });
  });

  it("issues a PII-free one-booking QR with the bearer only in the fragment", async () => {
    const result = await issueTurnIqCustomerCheckInLink("qa-salon", {
      kind: "booked_qr",
      bookingId: BOOKING_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkInPath).toContain("/turniq/check-in?");
    expect(result.checkInPath).toContain(`#cap=${TOKEN}`);
    expect(result.checkInPath.split("#")[0]).not.toContain(TOKEN);
    expect(result.checkInPath).not.toContain(BOOKING_ID);
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      serviceId: SERVICE_ID,
      maxUses: 1,
      actorUserId: USER_ID,
    }));
  });

  it("issues a bounded wildcard kiosk capability without booking context", async () => {
    await issueTurnIqCustomerCheckInLink("qa-salon", { kind: "walkin_kiosk" });
    expect(mocks.booking).not.toHaveBeenCalled();
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({
      bookingId: null,
      serviceId: null,
      channel: "kiosk",
      visitKind: "walkin",
      maxUses: 100,
    }));
  });

  it("fails closed for demo-cookie, nail-tech and disabled feature contexts", async () => {
    mocks.context.mockResolvedValueOnce({
      salon: { id: SALON_ID }, kind: "demo_cookie", role: "owner", userId: null,
    });
    await expect(issueTurnIqCustomerCheckInLink("qa-salon", { kind: "walkin_kiosk" }))
      .resolves.toEqual({ ok: false, error: "unauthorized" });

    mocks.context.mockResolvedValueOnce({
      salon: { id: SALON_ID }, kind: "member", role: "nail_tech", userId: USER_ID,
    });
    await expect(issueTurnIqCustomerCheckInLink("qa-salon", { kind: "walkin_kiosk" }))
      .resolves.toEqual({ ok: false, error: "forbidden" });

    mocks.visible.mockResolvedValueOnce(false);
    await expect(issueTurnIqCustomerCheckInLink("qa-salon", { kind: "walkin_kiosk" }))
      .resolves.toEqual({ ok: false, error: "feature_disabled" });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("does not open customer check-in while TurnIQ is shadow-only", async () => {
    mocks.stage.mockResolvedValueOnce("shadow");
    await expect(
      issueTurnIqCustomerCheckInLink("qa-salon", { kind: "walkin_kiosk" }),
    ).resolves.toEqual({ ok: false, error: "rollout_stage_blocked" });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("revokes by same-salon capability and authenticated actor", async () => {
    const result = await revokeTurnIqCustomerCheckInLink("qa-salon", CAPABILITY_ID);
    expect(result.ok).toBe(true);
    expect(mocks.revoke).toHaveBeenCalledWith({
      salonId: SALON_ID,
      capabilityId: CAPABILITY_ID,
      actorUserId: USER_ID,
    });
  });
});
