import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  attach: vi.fn(),
  deterministic: vi.fn(),
  model: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("@/shared/ai/anthropicProviderPolicy", () => ({
  createTextBackgroundAnthropicClient: () => ({ messages: { create: mocks.model } }),
}));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => db }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: async () => ({}) }));
vi.mock("@/shared/ai/agentPermissionFence", () => ({ isAiAgentPermissionEnabled: mocks.permission }));
vi.mock("@/shared/ai/executionLimit", () => ({
  ruleFirstOptimizationEnabled: () => false,
  claimAiExecutionSlot: async () => false,
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  isProviderTimeoutError: () => false,
  trackAnthropicMessage: (_context: unknown, callback: () => Promise<unknown>) => callback(),
}));
vi.mock("@/shared/noshow/scoreNoShowRisk", () => ({ deterministicNoShowRiskScore: () => ({ score: 80 }) }));
vi.mock("@/shared/integrations/square/noshow", () => ({
  autoAttachReturningCard: mocks.attach,
  noShowCardDecision: mocks.deterministic,
}));

import { gatherPolicyContext, runNoShowPolicyAgent } from "@/shared/noshow/agentNoShowPolicy";

const bookingId = "00000000-0000-4000-8000-000000000002";
const salonId = "00000000-0000-4000-8000-000000000003";
let booking: Record<string, unknown> | null;
let flags: Record<string, boolean>;

// The projection mock returns only requested fields, so omitting the durable
// state from the real select cannot accidentally pass these regressions.
const db = {
  from(table: string) {
    let columns = "";
    const chain = {
      select(value: string) { columns = value; return chain; },
      eq() { return chain; },
      not() { return chain; },
      limit() { return chain; },
      update(value: unknown) { mocks.update(table, value); return chain; },
      insert(value: unknown) { mocks.insert(table, value); return chain; },
      async maybeSingle() {
        const row = table === "bookings" ? booking : table === "salons" ? {
          noshow_protection_enabled: true, noshow_fee_percent: 20, feature_flags: flags,
        } : null;
        return { data: row && Object.fromEntries(columns.split(",").map(key => key.trim()).map(key => [key, row[key]])), error: null };
      },
      then(resolve: (result: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return chain;
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-not-a-provider-key");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in card truth unit tests"); }));
  flags = { ai_noshow_policy_live: true };
  booking = {
    id: bookingId, salon_id: salonId, client_name: "Synthetic Guest",
    price_cents: 5000, start_time_utc: "2026-10-01T10:00:00Z", created_at: "2026-09-01T10:00:00Z",
    noshow_card_required: true, noshow_card_id: "legacy-unverified-card", card_protection_status: "manual_review",
  };
  mocks.permission.mockResolvedValue(true);
  mocks.attach.mockResolvedValue({ attached: false });
  // Model and deterministic rule would both waive the card if reached. The
  // recovery boundary must hold even under this unfavorable legacy behavior.
  mocks.deterministic.mockResolvedValue({ required: false });
  mocks.model.mockResolvedValue({ content: [{ type: "text", text: '{"protection":"none","confidence":"high","reason":"synthetic"}' }] });
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("AI policy consumes durable card protection truth", () => {
  it.each([
    "awaiting_card", "saving", "reconciliation_pending", "retry_required", "manual_review", undefined, "invalid",
  ])("does not waive or redispatch unresolved protection: %s", async status => {
    booking!.card_protection_status = status;
    const context = await gatherPolicyContext(bookingId);
    expect(context).toMatchObject({ hasCardOnFile: false, cardRecoveryRequired: true });
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    { noshow_card_id: null, noshow_card_required: true },
    { noshow_card_id: "legacy-unverified-card", noshow_card_required: false },
  ])("fails closed on contradictory not-required projection: %j", async fields => {
    Object.assign(booking!, fields, { card_protection_status: "not_required" });
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps verified saved protection without duplicate work; applyToRow=%s", async applyToRow => {
    booking!.card_protection_status = "saved";
    expect(await gatherPolicyContext(bookingId)).toMatchObject({ hasCardOnFile: true, cardRecoveryRequired: false });
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow })).toEqual({ cardRequired: false });
    expect(mocks.update).toHaveBeenCalledTimes(applyToRow ? 1 : 0);
    if (applyToRow) expect(mocks.update).toHaveBeenCalledWith("bookings", { noshow_card_required: false });
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each(["manual_review", "saved", "not_required"])("preserves all AI flags OFF for %s", async status => {
    flags = {};
    booking!.card_protection_status = status;
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("rechecks live permission before applying saved protection", async () => {
    booking!.card_protection_status = "saved";
    mocks.permission.mockResolvedValue(false);
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still permits AI policy for a fresh booking with no existing requirement", async () => {
    Object.assign(booking!, { noshow_card_id: null, noshow_card_required: false, card_protection_status: "not_required" });
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toEqual({ cardRequired: false });
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith("bookings", { noshow_card_required: false });
  });

  it("requires a fresh durable projection after a returning-card attachment", async () => {
    Object.assign(booking!, { noshow_card_id: null, noshow_card_required: false, card_protection_status: "not_required" });
    mocks.attach.mockImplementation(async () => {
      booking!.noshow_card_id = "unverified-returning-card";
      booking!.card_protection_status = "manual_review";
      return { attached: true };
    });
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("does not reuse stale context if the post-attachment read fails", async () => {
    Object.assign(booking!, { noshow_card_id: null, noshow_card_required: false, card_protection_status: "not_required" });
    mocks.attach.mockImplementation(async () => { booking = null; return { attached: true }; });
    expect(await runNoShowPolicyAgent(bookingId, { applyToRow: true })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });
});
