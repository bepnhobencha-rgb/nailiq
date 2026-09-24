import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { computeKpiSnapshot } from "../loadReceptionistCenterData";

type Booking = Parameters<typeof computeKpiSnapshot>[0]["bookingsForDay"][number];
const now = Date.parse("2026-09-24T04:12:00Z");
function count(offsets: number[], status: Booking["status"] = "confirmed") {
  return computeKpiSnapshot({
    walkinQueue: [], staff: [], revenueModuleEnabled: false,
    bookingsForDay: offsets.map(offset => ({
      status, start_time_utc: new Date(now + offset * 60_000).toISOString(),
      end_time_utc: new Date(now + (offset + 20) * 60_000).toISOString(),
    } as Booking)),
  }).comingUpCount;
}
afterEach(() => vi.restoreAllMocks());
describe("receptionist Coming up (30m) snapshot", () => {
  it("counts the 4:30 appointment but not 5:00 when now is 4:12", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(count([18, 48])).toBe(1);
    vi.restoreAllMocks();
  });
  it("includes exactly 30 minutes, excludes now, past and beyond 30", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(count([-1, 0, 1, 30, 30.001, 60])).toBe(2);
    vi.restoreAllMocks();
  });
  it.each(["cancelled", "completed", "in_progress", "waiting"] as Booking["status"][])("excludes %s", status => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(count([15], status)).toBe(0);
    vi.restoreAllMocks();
  });
  it("includes pending within the window", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(count([15], "pending")).toBe(1);
    vi.restoreAllMocks();
  });
});
