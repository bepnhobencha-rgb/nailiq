import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), rpc: vi.fn(), send: vi.fn(), claim: vi.fn(),
  filters: [] as Array<[string, string, unknown]>,
  salon: {} as Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>,
  count: 0, receipt: false, legacy: false, attempt: false,
  errorTable: "", missingRows: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/ai/agentDigest", () => ({ sendDigestEmail: mocks.send }));
vi.mock("@/shared/ai/executionLimit", () => ({ claimAiExecutionSlot: mocks.claim }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["eq", "gte", "lt", "not"]) {
        chain[method] = (column: string, value: unknown) => {
          mocks.filters.push([table, column, value]);
          return chain;
        };
      }
      chain.select = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => Promise.resolve(mocks.query(table));
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.query(table)).then(resolve, reject);
      return chain;
    },
  }),
}));

import { isDigestBackfillDateEligible, runDigestBackfill } from "@/shared/ai/digestBackfill";

const salonId = "22222222-2222-4222-8222-222222222222";
const input = { salonId, reportDate: "2026-09-20" };

describe("bounded daily digest recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T06:30:00Z"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network during verification"); }));
    mocks.filters = [];
    mocks.salon = {
      name: "Synthetic Salon", slug: "e2e-digest", timezone: "America/Los_Angeles",
      archived_at: null, superadmin_locked_at: null,
      feature_flags: { ai_unified_digest: true },
      owner_notification_settings: { enabled: true, digest_emails: ["Owner@example.com", "manager@example.com"] },
    };
    mocks.rows = [
      { status: "completed", price_cents: 12345 },
      { status: "no_show", price_cents: null },
      { status: "cancelled", price_cents: 1000 },
      { status: "confirmed", price_cents: null },
    ];
    mocks.count = 4;
    mocks.receipt = false; mocks.legacy = false; mocks.attempt = false;
    mocks.errorTable = ""; mocks.missingRows = false;
    mocks.query.mockImplementation((table: string) => ({
      error: mocks.errorTable === table ? { message: "private detail" } : null,
      count: table === "bookings" ? mocks.count : null,
      data: table === "salons" ? mocks.salon
        : table === "ai_digest_deliveries" ? (mocks.receipt ? { id: "receipt" } : null)
          : table === "ai_actions_log" ? (mocks.legacy ? { id: "legacy" } : null)
            : table === "ai_execution_limits" ? (mocks.attempt ? { dedupe_key: input.reportDate } : null)
              : table === "bookings" ? (mocks.missingRows ? null : mocks.rows) : null,
    }));
    mocks.claim.mockImplementation(async () => {
      if (mocks.attempt) return false;
      mocks.attempt = true;
      return true;
    });
    mocks.send.mockResolvedValue({ status: "sent", providerMessageId: "provider-1", recipientCount: 2 });
    mocks.rpc.mockResolvedValue({ data: "delivery-1", error: null });
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("previews without claiming, sending or writing a receipt", async () => {
    await expect(runDigestBackfill(input, { dryRun: true })).resolves.toEqual({ status: "ready", reportDate: input.reportDate, recipientCount: 2 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("sends only dated factual totals to the pinned existing recipients and records acknowledgement", async () => {
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "sent", reportDate: input.reportDate, recipientCount: 2, providerMessageId: "provider-1" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(salonId, "Synthetic Salon", expect.stringContaining("$123.45"), input.reportDate, [], "e2e-digest", undefined, ["Owner@example.com", "manager@example.com"]);
    const body = mocks.send.mock.calls[0][2] as string;
    expect(body).toContain("4 lịch hẹn; 1 đã được đánh dấu hoàn thành");
    expect(body).toContain("không phải ảnh chụp dữ liệu tại cuối ngày");
    expect(mocks.claim).toHaveBeenCalledWith({ salonId, feature: "digest_backfill_send", dedupeKey: input.reportDate, windowSeconds: 2678400, maxCalls: 32 });
    expect(mocks.rpc).toHaveBeenCalledWith("record_ai_digest_delivery", {
      p_salon_id: salonId, p_digest_date: input.reportDate, p_provider_message_id: "provider-1",
      p_sent_at: "2026-09-21T06:30:00.000Z", p_approval_ids: [], p_agents_active: [], p_recipient_count: 2,
    });
    expect(mocks.filters).toContainEqual(["bookings", "start_time_utc", "2026-09-20T07:00:00.000Z"]);
    expect(mocks.filters).toContainEqual(["bookings", "start_time_utc", "2026-09-21T07:00:00.000Z"]);
    for (const table of ["ai_digest_deliveries", "ai_actions_log", "ai_execution_limits", "bookings"]) {
      expect(mocks.filters).toContainEqual([table, "salon_id", salonId]);
    }
  });
  it.each(["receipt", "legacy"] as const)("never resends a report with %s proof", async (key) => {
    mocks[key] = true;
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "already_sent", reportDate: input.reportDate });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("blocks an old attempt even without receipt, requiring reconciliation", async () => {
    mocks.attempt = true;
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "blocked", reason: "attempt_requires_review" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("lets only one concurrent recovery claim reach the sender", async () => {
    const results = await Promise.all([runDigestBackfill(input), runDigestBackfill(input)]);
    expect(results.filter((result) => result.status === "sent")).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each(["rejected", "timeout", "receipt"])("does not retry blindly after %s", async (failure) => {
    if (failure === "rejected") mocks.send.mockResolvedValue({ status: "failed", reason: "send_failed" });
    if (failure === "timeout") mocks.send.mockRejectedValue(new Error("secret recipient detail"));
    if (failure === "receipt") mocks.rpc.mockResolvedValue({ error: { message: "unavailable" } });
    const first = await runDigestBackfill(input);
    expect(first).toEqual(failure === "receipt"
      ? { status: "failed", reason: "receipt_unverified", providerMessageId: "provider-1" }
      : { status: "failed", reason: "delivery_unverified" });
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "blocked", reason: "attempt_requires_review" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it.each(["salons", "ai_digest_deliveries", "ai_actions_log", "ai_execution_limits", "bookings"])("fails closed for unavailable %s", async (table) => {
    mocks.errorTable = table;
    expect((await runDigestBackfill(input)).status).toBe("blocked");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each(["missing", "truncated", "null-price", "negative", "unsafe-total"])("rejects unverified totals: %s", async (condition) => {
    if (condition === "missing") mocks.missingRows = true;
    if (condition === "truncated") mocks.count = 1001;
    if (condition === "null-price") mocks.rows[0].price_cents = null;
    if (condition === "negative") mocks.rows[0].price_cents = -1;
    if (condition === "unsafe-total") {
      mocks.rows = [{ status: "completed", price_cents: Number.MAX_SAFE_INTEGER }, { status: "completed", price_cents: 1 }]; mocks.count = 2;
    }
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "blocked", reason: "stats_unavailable" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("allows a verified empty day without fabricating activity", async () => {
    mocks.rows = []; mocks.count = 0;
    expect((await runDigestBackfill(input)).status).toBe("sent");
    expect(mocks.send.mock.calls[0][2]).toContain("0 lịch hẹn; 0 đã được đánh dấu hoàn thành");
  });
  it.each([
    { digest_emails: [] },
    { digest_emails: ["invalid"] },
    { digest_emails: [null] },
    { digest_emails: Array.from({ length: 11 }, (_, i) => `owner${i}@example.com`) },
  ])("rejects missing or invalid explicit recipients $digest_emails", async ({ digest_emails }) => {
    mocks.salon.owner_notification_settings = { enabled: true, digest_emails };
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "blocked", reason: "recipients_unavailable" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("blocks when confirmed recipient count changed", async () => {
    await expect(runDigestBackfill(input, { expectedRecipientCount: 1 })).resolves.toEqual({ status: "blocked", reason: "recipients_unavailable" });
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it.each(["archived_at", "superadmin_locked_at", "feature_flags", "owner_notification_settings"])("preserves the %s disable control", async (field) => {
    mocks.salon[field] = field.endsWith("_at") ? "2026-09-01" : {};
    await expect(runDigestBackfill(input)).resolves.toEqual({ status: "blocked", reason: "salon_disabled" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(["2026-02-30", "2026-9-20", "2026-09-22", "2026-09-18"])("rejects invalid/future/old dates %s", async (reportDate) => {
    expect((await runDigestBackfill({ ...input, reportDate })).status).toBe("blocked");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects invalid salon IDs before reading data", async () => {
    await expect(runDigestBackfill({ ...input, salonId: "not-an-id" })).resolves.toEqual({ status: "blocked", reason: "invalid_input" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("keeps the selected date after local midnight", async () => {
    vi.setSystemTime(new Date("2026-09-21T08:00:00Z"));
    expect((await runDigestBackfill(input)).status).toBe("sent");
    expect(mocks.send.mock.calls[0][3]).toBe("2026-09-20");
  });
  it.each([
    ["2026-03-08", "2026-03-09T08:00:00Z", "2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"],
    ["2026-11-01", "2026-11-02T09:00:00Z", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
  ])("queries the actual DST day for %s", async (reportDate, now, start, end) => {
    vi.setSystemTime(new Date(now));
    expect((await runDigestBackfill({ ...input, reportDate }, { dryRun: true })).status).toBe("ready");
    expect(mocks.filters).toContainEqual(["bookings", "start_time_utc", start]);
    expect(mocks.filters).toContainEqual(["bookings", "start_time_utc", end]);
  });
  it("does not overlap the ordinary 21:00 cron and fails closed for invalid timezone", () => {
    expect(isDigestBackfillDateEligible("2026-09-20", "America/Los_Angeles", new Date("2026-09-21T04:59:59Z"))).toBe(false);
    expect(isDigestBackfillDateEligible("2026-09-20", "America/Los_Angeles", new Date("2026-09-21T05:00:00Z"))).toBe(true);
    expect(isDigestBackfillDateEligible("2026-09-20", "Invalid/Zone")).toBe(false);
  });
});
