import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), run: vi.fn(), audit: vi.fn(), from: vi.fn(), member: vi.fn() }));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({ requireActiveSuperAdminSession: mocks.auth }));
vi.mock("@/shared/ai/digestBackfill", () => ({ runDigestBackfill: mocks.run }));
vi.mock("@/shared/superadmin/audit", () => ({ writeAuditLog: mocks.audit }));
import { recoverSalonDigest } from "../digestBackfillActions";

const salonId = "11111111-1111-4111-8111-111111111111";
const base = { salonId, reportDate: "2026-09-20", mode: "send", confirmed: true, expectedRecipientCount: 2 };
const ready = { status: "ready", reportDate: base.reportDate, recipientCount: 2 };
let filters: [string, unknown][];
beforeEach(() => {
  vi.resetAllMocks();
  filters = [];
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn((k, v) => { filters.push([k, v]); return query; }), maybeSingle: mocks.member };
  mocks.from.mockReturnValue(query);
  mocks.member.mockResolvedValue({ data: { role: "owner" }, error: null });
  mocks.auth.mockResolvedValue({ ok: true, role: "founder", user: { id: "operator-id" }, supabase: { from: mocks.from } });
  mocks.audit.mockResolvedValue(true);
  mocks.run.mockResolvedValue(ready);
});

describe("digest recovery operator boundary", () => {
  it.each(["unauthenticated", "session_revoked", "auth_unavailable", "forbidden"])("blocks %s before any report access", async (code) => {
    mocks.auth.mockResolvedValue({ ok: false, code });
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(["support_admin", "billing_admin", "readonly_analyst", "ai_admin"])("blocks %s writes", async (role) => {
    mocks.auth.mockResolvedValue({ ok: true, role });
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "forbidden" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each([
    { ...base, salonId: "wrong" }, { ...base, reportDate: "2026-02-30" },
    { ...base, confirmed: false }, { ...base, expectedRecipientCount: undefined },
    { ...base, to: ["attacker@example.invalid"] }, { ...base, mode: "cron" },
  ])("rejects malformed/unconfirmed input", async (input) => {
    expect(await recoverSalonDigest(input)).toEqual({ ok: false, error: "invalid_input" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("requires target tenant membership even for a platform operator", async () => {
    mocks.member.mockResolvedValue({ data: null, error: null });
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "unauthorized" });
    expect(filters).toEqual([["salon_id", salonId], ["user_id", "operator-id"]]);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("rejects desk-only target membership", async () => {
    mocks.member.mockResolvedValue({ data: { role: "receptionist" }, error: null });
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "forbidden" });
  });
  it("check is read-only and never audits or sends", async () => {
    expect(await recoverSalonDigest({ ...base, mode: "check", confirmed: false })).toEqual({ ok: true, result: ready });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ salonId, reportDate: base.reportDate }, { dryRun: true });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("existing receipt never resends", async () => {
    mocks.run.mockResolvedValue({ status: "already_sent" });
    await recoverSalonDigest(base);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("recipient count changes require a fresh review", async () => {
    mocks.run.mockResolvedValue({ ...ready, recipientCount: 3 });
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "recipients_changed" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("audit failure prevents outbound send", async () => {
    mocks.audit.mockResolvedValue(false);
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "audit_failed" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("audits actor, salon and day before a single scoped send", async () => {
    mocks.run.mockResolvedValueOnce(ready).mockImplementationOnce(async () => {
      expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "operator-id", targetId: salonId, afterJsonb: { reportDate: base.reportDate, recipientCount: 2 } }));
      return { status: "sent" };
    });
    expect(await recoverSalonDigest(base)).toEqual({ ok: true, result: { status: "sent" } });
    expect(mocks.run).toHaveBeenLastCalledWith({ salonId, reportDate: base.reportDate }, { expectedRecipientCount: 2 });
  });
  it("does not disclose raw errors or automatically retry ambiguous sends", async () => {
    mocks.run.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error("private@example.invalid secret"));
    expect(await recoverSalonDigest(base)).toEqual({ ok: false, error: "verification_required" });
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
});
