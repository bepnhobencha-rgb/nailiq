import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({
  from: vi.fn(),
  ensure: vi.fn(),
  agent: vi.fn(),
}));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => ({ from: m.from }) }));
vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({ ensureNoShowCardRequirement: m.ensure }));
vi.mock("@/shared/noshow/agentNoShowPolicy", () => ({ runNoShowPolicyAgent: m.agent }));

import { handleBookingProtection } from "../handleBookingProtection";

const BOOKING = "22222222-2222-4222-8222-222222222222";
const SALON_A = "11111111-1111-4111-8111-111111111111";
const SALON_B = "33333333-3333-4333-8333-333333333333";

type QueryResult = { data: Record<string, unknown> | null; error: unknown };
let booking: QueryResult;
let salon: QueryResult;
let filters: Array<[string, string, unknown]>;

beforeEach(() => {
  vi.clearAllMocks();
  booking = { data: { id: BOOKING, salon_id: SALON_A }, error: null };
  salon = { data: { id: SALON_A, feature_flags: {} }, error: null };
  filters = [];
  m.from.mockImplementation((table: string) => ({
    select() { return this; },
    eq(key: string, value: unknown) { filters.push([table, key, value]); return this; },
    async maybeSingle() { return table === "bookings" ? booking : salon; },
  }));
  m.ensure.mockResolvedValue({ required: true, feeCents: 1000 });
  m.agent.mockResolvedValue(null);
});

describe("internal booking protection tenant boundary", () => {
  it("cannot be exported as a public Server Action", () => {
    const source = readFileSync(resolve(process.cwd(), "src/shared/noshow/handleBookingProtection.ts"), "utf8");
    expect(source).toContain('import "server-only"');
    expect(source).not.toMatch(/["']use server["']/u);
  });

  it.each(["online", "voice", "desk", "group", "wix", "quick_rebook"] as const)(
    "preserves authorized internal %s policy evaluation with scoped identity",
    async (channel) => {
      await handleBookingProtection(BOOKING, SALON_A, channel);
      expect(filters).toContainEqual(["bookings", "id", BOOKING]);
      expect(filters).toContainEqual(["bookings", "salon_id", SALON_A]);
      expect(m.ensure).toHaveBeenCalledExactlyOnceWith(BOOKING);
      expect(m.agent).not.toHaveBeenCalled();
    },
  );

  it.each([
    { data: null, error: null },
    { data: null, error: { message: "read unavailable" } },
    { data: { id: BOOKING, salon_id: SALON_B }, error: null },
    { data: { id: SALON_B, salon_id: SALON_A }, error: null },
    { data: { id: BOOKING, salon_id: SALON_A }, error: { message: "read uncertain" } },
  ])("does no policy work for a missing, foreign or uncertain booking: %j", async (result) => {
    booking = result;
    await handleBookingProtection(BOOKING, SALON_A, "desk");
    expect(m.from).toHaveBeenCalledExactlyOnceWith("bookings");
    expect(m.ensure).not.toHaveBeenCalled();
    expect(m.agent).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: { id: SALON_B }, error: null },
    { data: { id: SALON_A }, error: { message: "read unavailable" } },
  ])("does not fall back to a write when salon identity is unproven: %j", async (result) => {
    salon = result;
    await handleBookingProtection(BOOKING, SALON_A, "desk");
    expect(m.ensure).not.toHaveBeenCalled();
    expect(m.agent).not.toHaveBeenCalled();
  });

  it.each([["", SALON_A], [BOOKING, "bad-id"], ["not-a-booking", SALON_A]])(
    "rejects invalid identity before database access",
    async (id, sid) => {
      await handleBookingProtection(id, sid, "desk");
      expect(m.from).not.toHaveBeenCalled();
    },
  );

  it("does not expose thrown database/provider details in diagnostics", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.from.mockImplementation(() => { throw new Error("synthetic-secret-value"); });
      await expect(handleBookingProtection(BOOKING, SALON_A, "desk")).resolves.toBeUndefined();
      expect(logger).toHaveBeenCalledExactlyOnceWith("[handleBookingProtection] protection_evaluation_unavailable");
      expect(m.ensure).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });
});
