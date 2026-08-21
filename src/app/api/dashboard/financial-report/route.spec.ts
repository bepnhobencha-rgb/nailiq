import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  origin: vi.fn(), resolve: vi.fn(), visible: vi.fn(), rate: vi.fn(), parse: vi.fn(), verify: vi.fn(), csv: vi.fn(), pdf: vi.fn(), load: vi.fn(), limit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/sameOriginMutation", () => ({ isSameOriginMutation: mocks.origin }));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({ resolveSalonForDashboard: mocks.resolve }));
vi.mock("@/shared/features/platformFeatureFlags", () => ({ isReleaseFeatureVisible: mocks.visible }));
vi.mock("@/shared/reports/financialReportRateLimit", () => ({ checkFinancialReportRateLimits: mocks.rate }));
vi.mock("@/shared/reports/financialReportParser", () => ({ parseFinancialReportDto: mocks.parse }));
vi.mock("@/shared/reports/financialReportExportToken", () => ({ verifyFinancialReportSnapshot: mocks.verify }));
vi.mock("@/shared/reports/financialReportCsv", () => ({ renderFinancialReportCsv: mocks.csv }));
vi.mock("@/shared/reports/financialReportPdf", () => ({ renderFinancialReportPdf: mocks.pdf }));
vi.mock("@/shared/reports/loadFinancialReport", () => ({ loadFinancialReport: mocks.load }));
vi.mock("@/shared/reports/financialReportExportLimits", () => ({ assertFinancialReportExportable: mocks.limit }));

import { POST } from "./route";

const SALON = "11111111-1111-4111-8111-111111111111";
const USER = "21111111-1111-4111-8111-111111111111";
const report = { salon: { id: SALON }, range: { localFrom: "2026-08-20", localToExclusive: "2026-08-21" }, reportFingerprint: "a".repeat(64) };
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://nailiq.test/api/dashboard/financial-report", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://nailiq.test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("financial report export route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.origin.mockReturnValue(true);
    mocks.resolve.mockResolvedValue({ role: "owner", viewerUserId: USER, salon: { id: SALON } });
    mocks.visible.mockResolvedValue(true); mocks.rate.mockResolvedValue("allowed");
    mocks.parse.mockReturnValue(report); mocks.verify.mockReturnValue(true);
    mocks.csv.mockReturnValue("csv-body\r\n"); mocks.pdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });

  it("exports the exact signed DTO for a current same-tenant owner", async () => {
    const response = await POST(request({ slug: "qa", format: "csv", report, exportToken: "token" }));
    expect(response.status).toBe(200); expect(await response.text()).toContain("csv-body");
    expect(mocks.rate).toHaveBeenCalledWith(USER, SALON, "export");
    expect(mocks.verify).toHaveBeenCalledWith(report, USER, "token");
    expect(mocks.csv).toHaveBeenCalledWith(report);
  });

  it("exports PDF for a current same-tenant admin", async () => {
    mocks.resolve.mockResolvedValue({ role: "admin", viewerUserId: USER, salon: { id: SALON } });
    const response = await POST(request({ slug: "qa", format: "pdf", report, exportToken: "token" }));
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("rejects a tampered or expired signed DTO before either renderer", async () => {
    mocks.verify.mockReturnValue(false);
    const response = await POST(request({ slug: "qa", format: "csv", report, exportToken: "expired-or-tampered" }));
    expect(response.status).toBe(409); expect(mocks.csv).not.toHaveBeenCalled(); expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("blocks origin, current lower role, effective flag OFF, and cross-tenant DTO before render", async () => {
    mocks.origin.mockReturnValue(false);
    expect((await POST(request({ slug: "qa", format: "pdf", report, exportToken: "token" }))).status).toBe(403);
    mocks.origin.mockReturnValue(true); mocks.resolve.mockResolvedValue({ role: "receptionist", viewerUserId: USER, salon: { id: SALON } });
    expect((await POST(request({ slug: "qa", format: "pdf", report, exportToken: "token" }))).status).toBe(403);
    mocks.resolve.mockResolvedValue({ role: "owner", viewerUserId: USER, salon: { id: SALON } }); mocks.visible.mockResolvedValue(false);
    expect((await POST(request({ slug: "qa", format: "pdf", report, exportToken: "token" }))).status).toBe(403);
    mocks.visible.mockResolvedValue(true); mocks.parse.mockReturnValue({ ...report, salon: { id: "31111111-1111-4111-8111-111111111111" } });
    expect((await POST(request({ slug: "qa", format: "pdf", report, exportToken: "token" }))).status).toBe(409);
    expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it.each(["rate_limited", "unavailable"] as const)("fails closed when the durable export meter is %s", async (meter) => {
    mocks.rate.mockResolvedValue(meter);
    const response = await POST(request({ slug: "qa", format: "pdf", report, exportToken: "token" }));
    expect(response.status).toBe(meter === "rate_limited" ? 429 : 503);
    expect(mocks.parse).not.toHaveBeenCalled(); expect(mocks.pdf).not.toHaveBeenCalled();
  });

  it("caps actual streamed bytes even with a spoofed small Content-Length", async () => {
    const oversized = JSON.stringify({ slug: "qa", format: "csv", exportToken: "token", report: { padding: "x".repeat(4 * 1024 * 1024) } });
    const response = await POST(request(oversized, { "Content-Length": "100" }));
    expect(response.status).toBe(413); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.csv).not.toHaveBeenCalled();
  });
});
