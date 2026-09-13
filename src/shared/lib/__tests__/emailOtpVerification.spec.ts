import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({ from: mocks.from }) }));
vi.mock("@/shared/lib/resend", () => ({ getResendClient: vi.fn(), getResendFrom: vi.fn() }));
import { checkEmailOtp } from "../emailOtp";

const args = { salonId: "11111111-1111-4111-8111-111111111111", phone: "16045550199", email: "qa@example.test", code: "123456" };
const key = "synthetic-otp-test-key";
const row = { id: "22222222-2222-4222-8222-222222222222", code_hash: createHmac("sha256", key).update(args.code).digest("hex"), attempts: 0, expires_at: "2099-01-01T00:00:00Z", delivery_attempt_id: "33333333-3333-4333-8333-333333333333" };

// Simulates PostgREST's conditional UPDATE, including its zero-row success
// response. Reads snapshot concurrently; only one compare-and-set can win.
function database(options: { writeError?: boolean; readError?: boolean; attempts?: number } = {}) {
  const state = { ...row, attempts: options.attempts ?? 0, consumed_at: null as string | null };
  mocks.from.mockImplementation(() => {
    let patch: Record<string, unknown> | null = null;
    const conditions: Array<[string, unknown]> = [];
    const builder = {
      select: vi.fn(() => builder),
      update: vi.fn((value: Record<string, unknown>) => { patch = value; return builder; }),
      eq: vi.fn((field: string, value: unknown) => { conditions.push([field, value]); return builder; }),
      is: vi.fn((field: string, value: unknown) => { conditions.push([field, value]); return builder; }),
      gt: vi.fn(() => builder), order: vi.fn(() => builder), limit: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => execute()),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    function execute() {
      if (!patch) return options.readError ? { data: null, error: { code: "08006" } } : { data: state.consumed_at ? null : { ...state }, error: null };
      if (options.writeError) return { data: null, error: { code: "08006" } };
      const matches = conditions.every(([field, value]) => !(field in state) || state[field as keyof typeof state] === value);
      if (!matches) return { data: null, error: null };
      Object.assign(state, patch);
      return { data: { id: state.id }, error: null };
    }
    return builder;
  });
  return state;
}

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("INTERNAL_API_SECRET", key); });
afterEach(() => vi.unstubAllEnvs());

describe("email OTP durable one-time verification", () => {
  it("does not approve when consuming the code fails", async () => {
    database({ writeError: true });
    expect(await checkEmailOtp(args)).toMatchObject({ ok: false, error: "server_error" });
  });
  it("allows exactly one of twelve simultaneous correct verifications", async () => {
    database();
    const results = await Promise.all(Array.from({ length: 12 }, () => checkEmailOtp(args)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });
  it("accounts for concurrent wrong guesses and locks after five", async () => {
    const state = database();
    const results = await Promise.all(Array.from({ length: 12 }, () => checkEmailOtp({ ...args, code: "654321" })));
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(state.attempts).toBe(5);
    expect((await checkEmailOtp(args)).ok).toBe(false);
  });
  it("distinguishes a failed read from an expired code", async () => {
    database({ readError: true });
    expect(await checkEmailOtp(args)).toMatchObject({ ok: false, error: "server_error" });
  });
  it("consumes a successful code and rejects its subsequent replay", async () => {
    database();
    expect(await checkEmailOtp(args)).toEqual({ ok: true, deliveryAttemptId: row.delivery_attempt_id });
    expect((await checkEmailOtp(args)).ok).toBe(false);
  });
});
