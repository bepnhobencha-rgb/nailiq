import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  loadTurnIqCustomerStatusEta,
  type TurnIqCustomerStatusEtaRepository,
} from "@/shared/turniq/customerStatusEtaLoader";

const INPUT = {
  salonId: "11111111-1111-4111-8111-111111111111",
  bookingId: "22222222-2222-4222-8222-222222222222",
  groupId: null,
  bookingStatus: "confirmed",
  currentStartTimeUtc: "2026-09-02T17:20:00.000Z",
  durationMinutes: 60,
  nowIso: "2026-09-02T17:00:00.000Z",
};

function repository(
  overrides: Partial<TurnIqCustomerStatusEtaRepository> = {},
): TurnIqCustomerStatusEtaRepository {
  return {
    loadSalonFlags: vi.fn().mockResolvedValue({
      feature_flags: { turniq_trust_engine_enabled: true },
    }),
    loadConfirmedGroupPlan: vi.fn().mockResolvedValue(null),
    loadGroupPlanItems: vi.fn().mockResolvedValue([]),
    loadActiveAssignment: vi.fn().mockResolvedValue({
      status: "confirmed",
      decision_timestamp: "2026-09-02T16:59:00.000Z",
      updated_at: "2026-09-02T16:59:30.000Z",
    }),
    ...overrides,
  };
}

const visible = vi.fn().mockResolvedValue(true);

describe("TurnIQ M4K customer status ETA loader", () => {
  it("short-circuits before TurnIQ ledger reads when the feature is OFF", async () => {
    const repo = repository();
    const result = await loadTurnIqCustomerStatusEta(INPUT, {
      repository: repo,
      featureVisible: vi.fn().mockResolvedValue(false),
    });
    expect(result).toBeNull();
    expect(repo.loadSalonFlags).toHaveBeenCalledWith(INPUT.salonId);
    expect(repo.loadActiveAssignment).not.toHaveBeenCalled();
    expect(repo.loadConfirmedGroupPlan).not.toHaveBeenCalled();
  });

  it("projects a single booking without exposing ledger identifiers", async () => {
    const result = await loadTurnIqCustomerStatusEta(INPUT, {
      repository: repository(),
      featureVisible: visible,
    });
    expect(result).toMatchObject({
      surface: "waiting",
      waitRange: { earliestMinutes: 20, latestMinutes: 30 },
      partyFullyStartedRange: null,
    });
    expect(result?.estimateFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(
      /bookingId|salonId|staffId|revenue|tip|queuePosition|snapshotVersion/i,
    );
  });

  it("uses the member's start while separately showing when the whole group starts", async () => {
    const repo = repository({
      loadConfirmedGroupPlan: vi.fn().mockResolvedValue({
        id: "plan-private-id",
        party_size: 4,
        conservative_eta: { confidencePaddingMinutes: 8 },
        updated_at: "2026-09-02T16:59:30.000Z",
      }),
      loadGroupPlanItems: vi.fn().mockResolvedValue([
        { booking_id: "member-a", starts_at: "2026-09-02T17:05:00.000Z" },
        { booking_id: INPUT.bookingId, starts_at: "2026-09-02T17:15:00.000Z" },
        { booking_id: "member-c", starts_at: "2026-09-02T17:25:00.000Z" },
        { booking_id: "member-d", starts_at: "2026-09-02T17:25:00.000Z" },
      ]),
    });
    const result = await loadTurnIqCustomerStatusEta(
      { ...INPUT, groupId: "33333333-3333-4333-8333-333333333333" },
      { repository: repo, featureVisible: visible },
    );
    expect(result?.waitRange).toEqual({ earliestMinutes: 15, latestMinutes: 25 });
    expect(result?.partyFullyStartedRange).toEqual({
      earliestMinutes: 25,
      latestMinutes: 35,
    });
  });

  it("uses terminal assignment truth without inventing a wait range", async () => {
    const repo = repository({
      loadActiveAssignment: vi.fn().mockResolvedValue({
        status: "completed",
        decision_timestamp: "2026-09-02T16:00:00.000Z",
        updated_at: "2026-09-02T18:00:00.000Z",
      }),
    });
    const result = await loadTurnIqCustomerStatusEta(
      { ...INPUT, bookingStatus: "completed" },
      { repository: repo, featureVisible: visible },
    );
    expect(result).toMatchObject({ surface: "completed", waitRange: null });
  });

  it("preserves canonical booking status when any optional ETA read fails", async () => {
    const repo = repository({
      loadActiveAssignment: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });
    await expect(loadTurnIqCustomerStatusEta(INPUT, {
      repository: repo,
      featureVisible: visible,
    })).resolves.toBeNull();
  });

  it("fails closed for a group plan that does not contain this capability booking", async () => {
    const repo = repository({
      loadConfirmedGroupPlan: vi.fn().mockResolvedValue({
        id: "plan-private-id",
        party_size: 2,
        conservative_eta: {},
        updated_at: "2026-09-02T16:59:30.000Z",
      }),
      loadGroupPlanItems: vi.fn().mockResolvedValue([
        { booking_id: "member-a", starts_at: "2026-09-02T17:05:00.000Z" },
        { booking_id: "member-b", starts_at: "2026-09-02T17:10:00.000Z" },
      ]),
    });
    await expect(loadTurnIqCustomerStatusEta(
      { ...INPUT, groupId: "33333333-3333-4333-8333-333333333333" },
      { repository: repo, featureVisible: visible },
    )).resolves.toBeNull();
  });
});
