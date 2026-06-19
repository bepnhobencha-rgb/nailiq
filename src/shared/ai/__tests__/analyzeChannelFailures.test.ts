/**
 * Unit tests for analyzeChannelFailures.
 *
 * Uses vitest. Run: npx vitest src/shared/ai/__tests__/analyzeChannelFailures.test.ts
 *
 * Real Twilio / Supabase are NOT called — the DB client and createLesson are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelFailureResult } from "../analyzeChannelFailures";

// ---- Mocks ----

// server-only is a Next.js marker; no-op in tests
vi.mock("server-only", () => ({}));

// Track createLesson calls
let lessonCreatedId: string | null = "lesson-uuid-123";
vi.mock("../lessonMutations", () => ({
  createLesson: vi.fn(async () => lessonCreatedId),
}));

// Rows returned by the booking_notifications query
let mockNotifRows: { status: string; error_code: string | null }[] = [];

// Controls duplicate-lesson check: null = no existing lesson
let mockExistingLesson: { id: string } | null = null;

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "booking_notifications") {
        // Chainable query builder — resolves with mockNotifRows
        const chain: Record<string, unknown> = {};
        const noop = () => chain;
        chain.select = noop;
        chain.eq = noop;
        chain.neq = noop;
        chain.gte = noop;
        // Make the chain awaitable
        chain.then = (
          resolve: (v: {
            data: typeof mockNotifRows;
            error: null;
          }) => void,
        ) => {
          resolve({ data: mockNotifRows, error: null });
          return Promise.resolve();
        };
        return chain;
      }

      if (table === "minh_lessons") {
        // Duplicate-lesson check chain
        const chain: Record<string, unknown> = {};
        const noop = () => chain;
        chain.select = noop;
        chain.eq = noop;
        chain.or = noop;
        chain.contains = noop;
        chain.limit = noop;
        chain.maybeSingle = async () => ({
          data: mockExistingLesson,
          error: null,
        });
        return chain;
      }

      // ai_actions_log insert — just swallow
      return { insert: vi.fn(async () => ({ data: null, error: null })) };
    },
  }),
}));

// Import SUT after mocks
import { analyzeChannelFailures } from "../analyzeChannelFailures";
import { createLesson } from "../lessonMutations";

// ---- Helpers ----

function makeRows(
  delivered: number,
  failed: number,
): { status: string; error_code: string | null }[] {
  return [
    ...Array.from({ length: delivered }, () => ({
      status: "delivered",
      error_code: null,
    })),
    ...Array.from({ length: failed }, () => ({
      status: "failed",
      error_code: null,
    })),
  ];
}

// ---- Tests ----

describe("analyzeChannelFailures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lessonCreatedId = "lesson-uuid-123";
    mockExistingLesson = null;
  });

  it("creates a lesson when >50% of SMS sends fail (6/10)", async () => {
    mockNotifRows = makeRows(4, 6);

    const result: ChannelFailureResult = await analyzeChannelFailures(
      "salon-123",
    );

    expect(result.lessonCreated).toBe(true);
    expect(result.lessonId).toBe("lesson-uuid-123");
    expect(result.smsFailRate).toBeCloseTo(0.6);
    expect(createLesson).toHaveBeenCalledOnce();
    expect(createLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: "salon-123",
        scope: "channel",
        rule: expect.stringContaining("prefer_email"),
        source: "auto:twilio_fail_analysis",
        confidence: 0.8,
      }),
    );
  });

  it("does NOT create a lesson when fail rate is below 50% (2/10)", async () => {
    mockNotifRows = makeRows(8, 2);

    const result: ChannelFailureResult = await analyzeChannelFailures(
      "salon-456",
    );

    expect(result.lessonCreated).toBe(false);
    expect(result.lessonId).toBeNull();
    expect(result.smsFailRate).toBeCloseTo(0.2);
    expect(createLesson).not.toHaveBeenCalled();
  });

  it("does NOT create a lesson when sample size is below threshold (3 sends, 3 failed)", async () => {
    // 3 rows — below MIN_SAMPLE_SIZE of 5
    mockNotifRows = makeRows(0, 3);

    const result: ChannelFailureResult = await analyzeChannelFailures(
      "salon-789",
    );

    expect(result.lessonCreated).toBe(false);
    expect(result.lessonId).toBeNull();
    expect(result.smsFailRate).toBe(0); // short-circuits before computing fail rate
    expect(createLesson).not.toHaveBeenCalled();
  });

  it("counts error_code 30034 and 30007 as failures even when status is not 'failed'", async () => {
    // 4 delivered + 6 rows with A2P error codes but status 'sent'
    mockNotifRows = [
      ...Array.from({ length: 4 }, () => ({
        status: "delivered",
        error_code: null,
      })),
      { status: "sent", error_code: "30034" },
      { status: "sent", error_code: "30007" },
      { status: "sent", error_code: "30034" },
      { status: "sent", error_code: "30007" },
      { status: "sent", error_code: "30034" },
      { status: "sent", error_code: "30034" },
    ];

    const result: ChannelFailureResult = await analyzeChannelFailures(
      "salon-a2p",
    );

    expect(result.lessonCreated).toBe(true);
    expect(result.smsFailRate).toBeCloseTo(0.6);
    expect(createLesson).toHaveBeenCalledOnce();
  });

  it("is idempotent — skips creation when an active lesson already exists", async () => {
    mockNotifRows = makeRows(4, 6); // 60% failure → would normally create
    mockExistingLesson = { id: "existing-lesson-id" };

    const result: ChannelFailureResult = await analyzeChannelFailures(
      "salon-dup",
    );

    expect(result.lessonCreated).toBe(false);
    expect(result.lessonId).toBe("existing-lesson-id");
    expect(createLesson).not.toHaveBeenCalled();
  });
});
