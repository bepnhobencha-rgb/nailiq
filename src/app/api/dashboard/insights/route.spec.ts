import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSalonReports: vi.fn(),
}));

vi.mock("@/shared/dashboard/loadSalonReports", () => ({
  loadSalonReports: mocks.loadSalonReports,
}));

import { GET } from "@/app/api/dashboard/insights/route";

describe("GET /api/dashboard/insights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no report payload when the authoritative loader blocks the effective flag", async () => {
    mocks.loadSalonReports.mockResolvedValue({
      ok: false,
      error: "feature_not_enabled",
    });

    const response = await GET(
      new Request(
        "https://nailiq.example/api/dashboard/insights?slug=qa-salon&range=today",
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "feature_not_enabled",
    });
    expect(mocks.loadSalonReports).toHaveBeenCalledWith("qa-salon", "today");
  });

  it("returns the loader's authorized report result without a second data path", async () => {
    mocks.loadSalonReports.mockResolvedValue({
      ok: true,
      data: { appointmentCount: 0, totalRevenueCents: 0 },
    });

    const response = await GET(
      new Request(
        "https://nailiq.example/api/dashboard/insights?slug=qa-salon&range=month",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { appointmentCount: 0, totalRevenueCents: 0 },
    });
    expect(mocks.loadSalonReports).toHaveBeenCalledWith("qa-salon", "month");
  });

  it("rejects malformed input before calling the loader", async () => {
    const response = await GET(
      new Request(
        "https://nailiq.example/api/dashboard/insights?slug=qa-salon&range=year",
      ),
    );

    expect(response.status).toBe(400);
    expect(mocks.loadSalonReports).not.toHaveBeenCalled();
  });
});
