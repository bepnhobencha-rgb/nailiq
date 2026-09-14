import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authorization: vi.fn(), tracked: vi.fn(), from: vi.fn(), rpc: vi.fn(),
  limit: vi.fn(), oldPause: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("@/shared/security/cronAuthorization", () => ({ requireCronAuthorization: mocks.authorization }));
vi.mock("@/shared/security/cronRunHistory", () => ({ runTrackedCron: mocks.tracked }));
vi.mock("@/shared/subscriptions/tenantPause", () => ({ pauseTenant: mocks.oldPause }));
vi.mock("@/shared/superadmin/audit", () => ({ writeAuditLog: mocks.audit }));

import { GET } from "./route";

const SALON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AUDIT = "33333333-3333-4333-8333-333333333333";
const DEADLINE = "2026-01-01T12:00:00.123456+00:00";
const row = { id: SALON, payment_grace_ends_at: DEADLINE };
const receipt = { ok: true, code: "paused", salon_id: SALON, audit_id: AUDIT };
const request = () => new NextRequest("https://nailiq.test/api/cron/tenant-payment-pause");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorization.mockReturnValue(null);
  mocks.tracked.mockImplementation((_name: string, run: () => Promise<Response>) => run());
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), not: vi.fn(), lte: vi.fn(), limit: mocks.limit };
  for (const method of [query.select, query.eq, query.is, query.not, query.lte]) method.mockReturnValue(query);
  mocks.from.mockReturnValue(query);
  mocks.limit.mockResolvedValue({ data: [row], error: null });
  mocks.rpc.mockResolvedValue({ data: receipt, error: null });
});

describe("tenant payment pause current-state fence", () => {
  it("rejects unauthorized cron before any database work", async () => {
    mocks.authorization.mockReturnValue(new Response(null, { status: 401 }));
    expect((await GET(request())).status).toBe(401);
    expect(mocks.tracked).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("passes the exact deadline without rounding and requires an atomic audit receipt", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, eligible: 1, paused: 1, skipped: 0, failed: [] });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("pause_tenant_if_payment_grace_expired", {
      p_salon_id: SALON, p_expected_deadline: DEADLINE,
    });
    expect(mocks.oldPause).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does no mutation when the database reports paid or extended grace", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, code: "skipped_not_eligible", salon_id: SALON }, error: null });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paused: 0, skipped: 1, failed: [] });
    expect(mocks.oldPause).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("handles an empty batch without a provider or database mutation", async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    expect(await (await GET(request())).json()).toMatchObject({ eligible: 0, paused: 0, skipped: 0 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { code: "read_timeout" } },
    { data: null, error: null },
    { data: {}, error: null },
  ])("does not turn failed/malformed discovery into no work: %j", async (result) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.limit.mockResolvedValue(result);
    expect((await GET(request())).status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("[tenant-payment-pause] query failed");
    logged.mockRestore();
  });

  it.each([
    null, [], {}, { ...receipt, ok: false }, { ...receipt, salon_id: OTHER },
    { ...receipt, audit_id: null }, { ...receipt, audit_id: "invalid" },
    { ...receipt, code: "unknown" }, { ok: true, code: "skipped_not_eligible", salon_id: OTHER },
  ])("rejects missing or mismatched receipts without fallback: %j", async (value) => {
    mocks.rpc.mockResolvedValue({ data: value, error: null });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, paused: 0, skipped: 0, failed: [SALON] });
    expect(mocks.oldPause).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails safely on missing RPC and response loss without an ID-only fallback", async () => {
    mocks.rpc.mockRejectedValue(new Error("response lost with synthetic private detail"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ failed: [SALON], paused: 0 });
    expect(mocks.oldPause).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does not accept a receipt accompanied by a database error", async () => {
    mocks.rpc.mockResolvedValue({ data: receipt, error: { code: "timeout" } });
    expect((await GET(request())).status).toBe(503);
  });

  it.each([null, { id: "bad", payment_grace_ends_at: DEADLINE }, { ...row, payment_grace_ends_at: null }, { ...row, payment_grace_ends_at: "infinity" }])("rejects malformed discovery rows: %j", async (value) => {
    mocks.limit.mockResolvedValue({ data: [value], error: null });
    expect((await GET(request())).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accepts version 7 tenant and audit UUIDs", async () => {
    const salonV7 = SALON.replace("-4111-", "-7111-");
    const auditV7 = AUDIT.replace("-4333-", "-7333-");
    mocks.limit.mockResolvedValue({ data: [{ ...row, id: salonV7 }], error: null });
    mocks.rpc.mockResolvedValue({ data: { ...receipt, salon_id: salonV7, audit_id: auditV7 }, error: null });
    expect((await GET(request())).status).toBe(200);
  });

  it("continues a mixed batch while reporting failed items truthfully", async () => {
    mocks.limit.mockResolvedValue({ data: [row, { ...row, id: OTHER }], error: null });
    mocks.rpc.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ data: { ...receipt, salon_id: OTHER }, error: null });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, eligible: 2, paused: 1, skipped: 0, failed: [SALON] });
  });
});
