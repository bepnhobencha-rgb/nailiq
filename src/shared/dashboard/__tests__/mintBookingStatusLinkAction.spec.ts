import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  mint: vi.fn(),
  booking: {
    id: "11111111-1111-4111-8111-111111111111",
    start_time_utc: "2099-08-20T17:00:00.000Z",
  } as Record<string, unknown> | null,
}));

function bookingQuery() {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    is: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: mocks.booking, error: null })),
  };
  return builder;
}

vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.context,
}));
vi.mock("@/shared/noshow/generateReminderToken", () => ({
  generateReminderToken: mocks.mint,
}));

import { mintBookingStatusLink } from "../mintBookingStatusLinkAction";

describe("authorized desk status capability link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.booking = {
      id: "11111111-1111-4111-8111-111111111111",
      start_time_utc: "2099-08-20T17:00:00.000Z",
    };
    mocks.context.mockResolvedValue({
      role: "owner",
      salon: { id: "22222222-2222-4222-8222-222222222222" },
      supabase: { from: () => bookingQuery() },
    });
    mocks.mint.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
  });

  it("mints status-only after same-salon booking authorization and returns no naked id URL", async () => {
    const result = await mintBookingStatusLink("qa-salon", String(mocks.booking?.id));
    expect(result).toEqual({
      ok: true,
      statusCapabilityPath: "/booking/status?token=33333333-3333-4333-8333-333333333333",
    });
    expect(mocks.mint).toHaveBeenCalledWith(
      mocks.booking?.id,
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({ action: "status" }),
    );
    expect(JSON.stringify(result)).not.toContain(`/wait/${String(mocks.booking?.id)}`);
  });

  it("fails before capability mint when the caller cannot prove the booking belongs to the salon", async () => {
    mocks.booking = null;
    await expect(mintBookingStatusLink("qa-salon", "other-booking")).resolves.toEqual({
      ok: false,
      error: "invalid_booking",
    });
    expect(mocks.mint).not.toHaveBeenCalled();
  });
});
