import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), visible: vi.fn(), service: vi.fn(), rate: vi.fn(), sign: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({ resolveSalonForDashboard: mocks.resolve }));
vi.mock("@/shared/features/platformFeatureFlags", () => ({ isReleaseFeatureVisible: mocks.visible }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("../financialReportRateLimit", () => ({ checkFinancialReportRateLimits: mocks.rate }));
vi.mock("../financialReportExportToken", () => ({ signFinancialReportSnapshot: mocks.sign }));

import { loadFinancialReport } from "../loadFinancialReport";

const SALON = "11111111-1111-4111-8111-111111111111";
const USER = "21111111-1111-4111-8111-111111111111";
function resolved(role: "owner" | "admin" | "receptionist" = "owner") {
  return { kind: "member", role, viewerUserId: USER, viewerEmail: null, salon: { id: SALON, slug: "qa", feature_flags: { advanced_reports_enabled: true } } };
}
function coverage(unit: "booking" | "operation" | "evidence", state: string, reason: string[] = []) {
  return { unit, state, included_rows: 0, excluded_rows: 0, reason_codes: reason, source_counts: {} };
}
function dbReport(salonId = SALON) {
  return {
    success: true, code: "loaded", schema_version: 2, source_fingerprint: "a".repeat(64),
    salon: { id: salonId, name: "QA", timezone: "UTC", currency: "CAD" },
    range: { local_from: "2026-08-20", local_to_exclusive: "2026-08-21", utc_from: "2026-08-20T00:00:00Z", utc_to_exclusive: "2026-08-21T00:00:00Z", effective_utc_to_exclusive: "2026-08-20T18:00:00Z" },
    generated_at: "2026-08-20T18:00:00Z", data_as_of: "2026-08-20T18:00:00Z", basis: "booking_estimate",
    coverage: {
      booking_pricing: coverage("booking", "unknown"), tax: { ...coverage("booking", "unknown"), basis: "booking_estimate" },
      payments: coverage("operation", "unknown", ["service_and_external_payments_not_reconciled"]),
      refunds: coverage("operation", "unknown", ["external_refunds_not_reconciled"]),
      tips: coverage("evidence", "not_configured", ["authoritative_tip_ingestion_not_configured"]),
      commission: coverage("evidence", "not_configured", ["approved_commission_policy_not_configured"]),
    },
    totals: { booked_subtotal_cents: null, booked_tax_cents: null, booked_total_cents: null, collected_gross_cents: null, refund_cents: null, collected_net_cents: null, tip_cents: null, commission_cents: null },
    booking_rows: [], operation_events: [], metric_events: [], metric_policies: [],
  };
}

describe("authoritative financial report loader", () => {
  const rpc = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockResolvedValue(resolved()); mocks.visible.mockResolvedValue(true);
    mocks.rate.mockResolvedValue("allowed"); mocks.sign.mockReturnValue("signed");
    rpc.mockResolvedValue({ data: dbReport(), error: null }); mocks.service.mockReturnValue({ rpc });
  });

  it.each(["owner", "admin"] as const)("loads for a same-tenant %s after effective gate and durable meters", async (role) => {
    mocks.resolve.mockResolvedValue(resolved(role));
    const result = await loadFinancialReport("qa", "2026-08-20", "2026-08-21");
    expect(result).toMatchObject({ ok: true, exportToken: "signed", report: { salon: { id: SALON }, reportFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(mocks.rate).toHaveBeenCalledWith(USER, SALON, "load");
    expect(rpc).toHaveBeenCalledWith("load_authoritative_financial_report", expect.objectContaining({ p_salon_id: SALON, p_actor_user_id: USER, p_data_as_of: null }));
  });

  it("rejects anonymous/cross-tenant and lower-role viewers before service-role report access", async () => {
    mocks.resolve.mockResolvedValue(null);
    await expect(loadFinancialReport("foreign", "2026-08-20", "2026-08-21")).resolves.toEqual({ ok: false, error: "unauthorized" });
    mocks.resolve.mockResolvedValue(resolved("receptionist"));
    await expect(loadFinancialReport("qa", "2026-08-20", "2026-08-21")).resolves.toEqual({ ok: false, error: "forbidden" });
    expect(mocks.rate).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed for platform unavailable/global OFF or tenant OFF", async () => {
    mocks.visible.mockResolvedValue(false);
    await expect(loadFinancialReport("qa", "2026-08-20", "2026-08-21")).resolves.toEqual({ ok: false, error: "feature_not_enabled" });
    expect(mocks.rate).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });

  it.each([["rate_limited", "rate_limited"], ["unavailable", "limiter_unavailable"]] as const)("fails closed when durable meter is %s", async (meter, error) => {
    mocks.rate.mockResolvedValue(meter);
    await expect(loadFinancialReport("qa", "2026-08-20", "2026-08-21")).resolves.toEqual({ ok: false, error });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant report payload", async () => {
    rpc.mockResolvedValue({ data: dbReport("31111111-1111-4111-8111-111111111111"), error: null });
    await expect(loadFinancialReport("qa", "2026-08-20", "2026-08-21")).resolves.toEqual({ ok: false, error: "report_unavailable" });
  });

  it("preserves the authoritative early report-size refusal", async () => {
    rpc.mockResolvedValue({
      data: {
        success: false,
        code: "report_too_large",
        max_records: 700,
      },
      error: null,
    });

    await expect(
      loadFinancialReport("qa", "2026-01-01", "2027-01-01"),
    ).resolves.toEqual({ ok: false, error: "report_too_large" });
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
